import assert from 'node:assert/strict';
import {createWriteStream, promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {finished} from 'node:stream/promises';
import archiver from 'archiver';
import StreamZip from 'node-stream-zip';
import {SignatureClient} from '../src/Signature.js';

async function buildFixture(ipaPath) {
    const output = createWriteStream(ipaPath);
    const archive = archiver('zip');
    archive.pipe(output);
    archive.append('placeholder', {name: 'Payload/Test.app/SC_Info/Test.supp'});
    archive.append('app binary', {name: 'Payload/Test.app/Test'});
    archive.append('old metadata', {name: 'iTunesMetadata.plist'});
    await archive.finalize();
    await finished(output);
}

async function entryNames(ipaPath) {
    const zip = new StreamZip.async({file: ipaPath});
    try {
        return Object.keys(await zip.entries()).sort();
    } finally {
        await zip.close();
    }
}

test('removes App Store metadata only after the standard IPA signing pass', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pastel-signature-test-'));
    const ipaPath = path.join(tempDir, 'Test.ipa');
    try {
        await buildFixture(ipaPath);
        const signer = new SignatureClient({
            metadata: {bundleDisplayName: 'Test'},
            sinfs: [{sinf: Buffer.from('signature').toString('base64')}],
        }, 'test@example.com');

        await signer.sign(ipaPath);
        assert.deepEqual(await entryNames(ipaPath), [
            'Payload/Test.app/SC_Info/Test.sinf',
            'Payload/Test.app/SC_Info/Test.supp',
            'Payload/Test.app/Test',
            'iTunesMetadata.plist',
        ]);

        await signer.removeAppStoreMetadata(ipaPath);
        assert.deepEqual(await entryNames(ipaPath), [
            'Payload/Test.app/SC_Info/Test.sinf',
            'Payload/Test.app/SC_Info/Test.supp',
            'Payload/Test.app/Test',
        ]);
    } finally {
        await fs.rm(tempDir, {recursive: true, force: true});
    }
});
