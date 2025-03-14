import { EDITOR } from 'internal:constants';
import { Mat4, Vec2, Vec4 } from '../../../core';
import { game } from '../../../game';
import { ClearFlagBit, Format } from '../../../gfx';
import { Camera } from '../../../render-scene/scene';
import { Pipeline, ResourceResidency } from '../../custom';
import { getCameraUniqueID } from '../../custom/define';
import { TAA } from '../components/taa';
import { passContext } from '../utils/pass-context';
import { getSetting, SettingPass } from './setting-pass';

const tempVec4 = new Vec4();

const halton8 = [
    new Vec2(0.5, 1.0 / 3),
    new Vec2(0.25, 2.0 / 3),
    new Vec2(0.75, 1.0 / 9),
    new Vec2(0.125, 4.0 / 9),
    new Vec2(0.625, 7.0 / 9),
    new Vec2(0.375, 2.0 / 9),
    new Vec2(0.875, 5.0 / 9),
    new Vec2(0.0625, 8.0 / 9),
];
halton8.forEach((v) => {
    v.x -= 0.5;
    v.y -= 0.5;
});

const SampleOffsets = {
    // 2xMSAA
    // Pattern docs: http://msdn.microsoft.com/en-us/library/windows/desktop/ff476218(v=vs.85).aspx
    //   N.
    //   .S
    x2: [
        new Vec2(-4.0 / 16.0, -4.0 / 16.0),
        new Vec2(4.0 / 16.0, 4.0 / 16.0),
    ],

    // 3xMSAA
    //   A..
    //   ..B
    //   .C.
    // Rolling circle pattern (A,B,C).
    x3: [
        new Vec2(-2.0 / 3.0, -2.0 / 3.0),
        new Vec2(2 / 3, 0 / 3),
        new Vec2(0 / 3, 2 / 3),
    ],

    // 4xMSAA
    // Pattern docs: http://msdn.microsoft.com/en-us/library/windows/desktop/ff476218(v=vs.85).aspx
    //   .N..
    //   ...E
    //   W...
    //   ..S.
    // Rolling circle pattern (N,E,S,W).
    x4: [
        new Vec2(-2 / 16, -6 / 16),
        new Vec2(6 / 16, -2 / 16),
        new Vec2(2 / 16, 6 / 16),
        new Vec2(-6 / 16, 2 / 16),
    ],

    x5: [
        // Compressed 4 sample pattern on same vertical and horizontal line (less temporal flicker).
        // Compressed 1/2 works better than correct 2/3 (reduced temporal flicker).
        //   . N .
        //   W . E
        //   . S .
        // Rolling circle pattern (N,E,S,W).
        new Vec2(0, -1 / 2),
        new Vec2(1 / 2, 0),
        new Vec2(0, 1 / 2),
        new Vec2(-1 / 2, 0),
    ],

    halton8,
};

export class TAAPass extends SettingPass {
    get setting () { return getSetting(TAA); }

    name = 'TAAPass'
    effectName = 'pipeline/post-process/taa';
    outputNames = ['TAA_First', 'TAA_Second'];

    prevMatViewProj = new Mat4();
    taaTextureIndex = -2;
    samples = SampleOffsets.halton8;
    sampleIndex = -1;
    sampleOffset = new Vec2();

    forceRender = true;
    dirty = false;

    slotName (camera: Camera, index = 0) {
        if (!this.checkEnable(camera)) {
            return this.lastPass!.slotName(camera, index);
        }

        if (this.taaTextureIndex < 0) {
            return super.slotName(camera, 0);
        }

        return super.slotName(camera, (this.taaTextureIndex + 1) % 2);
    }

    applyCameraJitter (camera: Camera) {
        (camera as any)._isProjDirty = true;
        camera.update(true);

        camera.matProj.m12 += this.sampleOffset.x;
        camera.matProj.m13 += this.sampleOffset.y;

        Mat4.invert(camera.matProjInv, camera.matProj);
        Mat4.multiply(camera.matViewProj, camera.matProj, camera.matView);
        Mat4.invert(camera.matViewProjInv, camera.matViewProj);
        camera.frustum.update(camera.matViewProj, camera.matViewProjInv);
    }

    updateSample () {
        if (this.dirty || this.forceRender) {
            this.sampleIndex++;
            this.taaTextureIndex++;
            this.dirty = false;
        }

        let offset = this.samples[this.sampleIndex % this.samples.length];
        if (this.sampleIndex === -1) {
            offset = Vec2.ZERO;
        }

        const setting = this.setting;

        this.sampleOffset.x = offset.x * setting.sampleScale / game.canvas!.width;
        this.sampleOffset.y = offset.y * setting.sampleScale / game.canvas!.height;
    }

    firstRender = true;
    public render (camera: Camera, ppl: Pipeline): void {
        if (!this.checkEnable(camera)) {
            return;
        }

        const cameraID = getCameraUniqueID(camera);
        const area = this.getRenderArea(camera);
        const width = area.width;
        const height = area.height;

        passContext.clearFlag = ClearFlagBit.COLOR;
        Vec4.set(passContext.clearColor, 0, 0, 0, 1);

        passContext.material = this.material;

        const firstRender = this.firstRender;
        if (firstRender) {
            this.prevMatViewProj.set(camera.matViewProj);
            this.firstRender = false;
        }

        const setting = this.setting;

        this.material.setProperty('taaParams1', tempVec4.set(this.sampleOffset.x, this.sampleOffset.y, setting.feedback, 0));
        this.material.setProperty('taaTextureSize', tempVec4.set(1 / width, 1 / height, 1 / width, 1 / height));
        this.material.setProperty('taaPrevViewProj', this.prevMatViewProj);
        this.prevMatViewProj.set(camera.matViewProj);

        // input output
        const input0 = this.lastPass!.slotName(camera, 0);
        let historyTexture = super.slotName(camera, this.taaTextureIndex % 2);

        if (firstRender) {
            historyTexture = input0;
        }

        const slot0 = this.slotName(camera, 0);
        const depthTex = passContext.forwardPass.slotName(camera, 1);

        const layoutName = `DeferredTAA${this.taaTextureIndex < 0 ? -1 : (this.taaTextureIndex % 2)}`;
        passContext.addRasterPass(width, height, layoutName, `CameraTAAPass${cameraID}`)
            .setViewport(area.x, area.y, width, height)
            .setPassInput(input0, 'inputTexture')
            .setPassInput(depthTex, 'depthTex')
            .setPassInput(historyTexture, 'taaPrevTexture');

        passContext.addRasterView(slot0, Format.RGBA16F, true, ResourceResidency.PERSISTENT)
            .blitScreen(0)
            .version();
    }
}
