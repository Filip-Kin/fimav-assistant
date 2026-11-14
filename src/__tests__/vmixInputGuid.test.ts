// Filip, from a live event: a Companion button saved against a PowerPoint
// input's TITLE goes dead the moment the slide changes ("... - Slide8" is
// part of the title vMix reports). "We should definitely be using the
// guids." These tests cover the three places that bug touched: the picker's
// unknown-input match, migrating an old saved title to the current key, and
// the shape `bitfocus:getVmixInputs` now sends the renderer.
import {
    matchVmixInput,
    resolveVmixInputValue,
    VmixInputOption,
} from '../models/Bitfocus';
import { vmixInputOptions } from '../main/bitfocus';

jest.mock('../main/store', () => ({ getStore: () => ({ get: () => 8888 }) }));

const PPT_TITLE =
    '2026-27 FTC Sponsor Recognition Powerpoint.pptx - Slide8';

const inputs: VmixInputOption[] = [
    { key: 'key-camera', number: 1, title: 'Camera 1' },
    { key: 'key-ppt', number: 2, title: PPT_TITLE },
];

describe('matchVmixInput', () => {
    it('matches by key', () => {
        expect(matchVmixInput('key-camera', inputs)).toBe(inputs[0]);
    });

    it('matches by exact title', () => {
        expect(matchVmixInput('Camera 1', inputs)).toBe(inputs[0]);
    });

    it('matches by number', () => {
        expect(matchVmixInput('1', inputs)).toBe(inputs[0]);
    });

    it('matches a PowerPoint title with the slide suffix stripped on both sides', () => {
        const savedOnAnotherSlide =
            '2026-27 FTC Sponsor Recognition Powerpoint.pptx - Slide2';
        expect(matchVmixInput(savedOnAnotherSlide, inputs)).toBe(inputs[1]);
    });

    it('finds nothing for a title vMix no longer has', () => {
        expect(matchVmixInput('Retired Input', inputs)).toBeUndefined();
    });

    it('finds nothing for an empty value', () => {
        expect(matchVmixInput('', inputs)).toBeUndefined();
    });
});

describe('resolveVmixInputValue (migration on Save)', () => {
    it('resolves an old saved title to the current key', () => {
        expect(resolveVmixInputValue('Camera 1', inputs)).toBe('key-camera');
    });

    it('resolves a title saved on a different slide to the current key', () => {
        const savedOnAnotherSlide =
            '2026-27 FTC Sponsor Recognition Powerpoint.pptx - Slide1';
        expect(resolveVmixInputValue(savedOnAnotherSlide, inputs)).toBe(
            'key-ppt'
        );
    });

    it('leaves an already-migrated key untouched', () => {
        expect(resolveVmixInputValue('key-ppt', inputs)).toBe('key-ppt');
    });

    it('leaves a value nothing matches exactly as saved, so the outline keeps flagging it', () => {
        expect(resolveVmixInputValue('Retired Input', inputs)).toBe(
            'Retired Input'
        );
    });
});

describe('vmixInputOptions (bitfocus:getVmixInputs IPC shape)', () => {
    it('keeps key, number and title and drops the vMix input type', () => {
        const raw = [
            { key: 'k1', number: 1, title: 'Camera 1', type: 'Camera' },
            { key: 'k2', number: 2, title: PPT_TITLE, type: 'PowerPoint' },
        ];
        expect(vmixInputOptions(raw)).toEqual([
            { key: 'k1', number: 1, title: 'Camera 1' },
            { key: 'k2', number: 2, title: PPT_TITLE },
        ]);
    });
});
