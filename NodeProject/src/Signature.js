import { promises as fsPromises, createReadStream, createWriteStream } from 'fs';
import {finished} from 'stream/promises';
import { createHash } from 'crypto';
import StreamZip from 'node-stream-zip';
import archiver from 'archiver';
import plist from 'plist';
import {t} from './i18n.js';

export class SignatureClient {
    constructor(songInfo, email) {
        this.expectedMd5 = songInfo?.md5;
        this.metadata = {...songInfo.metadata, 'apple-id': email, userName: email, 'appleId': email, 'com.apple.iTunesStore.downloadInfo': {'accountInfo': {'AppleID': email}}};
        this.signature = songInfo?.sinfs[0]?.sinf;
        if (!this.signature) {
            const e = new Error(t('sign_init_failed'));
            e.prefix = 'SIGN';
            throw e;
        }
    }

    async calculateMD5(filePath) {
        return new Promise((resolve, reject) => {
            try {
                const hash = createHash('md5');
                const stream = createReadStream(filePath);
                stream.on('data', data => hash.update(data));
                stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
                stream.on('error', err => {
                    console.error(t('md5_read_failed'), err);
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    async sign(ipaPath) {
        if (this.expectedMd5) {
            console.log(t('verify_checking'));
            const currentMd5 = await this.calculateMD5(ipaPath);
            if (currentMd5 !== this.expectedMd5.toLowerCase()) {
                const e = new Error(t('verify_md5_mismatch', {expected: this.expectedMd5, actual: currentMd5}));
                e.prefix = 'VERIFY';
                throw e;
            }
            console.log(t('verify_md5_ok'));
        }

        console.log(t('sign_processing'));
        const tempIpaPath = ipaPath + '.tmp';
        let readZip;
        let success = false;
        try {
            readZip = new StreamZip.async({file: ipaPath});
            const output = createWriteStream(tempIpaPath);
            const archive = archiver('zip', {zlib: {level: 1}});
            archive.pipe(output);
            const entries = await readZip.entries();
            const mainAppSuppRegex = /^Payload\/[^\/]+\.app\/SC_Info\/[^\/]+\.supp$/i;
            const candidates = Object.values(entries).filter(entry => mainAppSuppRegex.test(entry.name));
            if (candidates.length === 0) {
                const e = new Error(t('sign_no_supp'));
                e.prefix = 'SIGN';
                throw e;
            }
            const suppFileEntry = candidates.sort((a, b) => a.name.length - b.name.length)[0];
            const signatureTargetPath = suppFileEntry.name.replace(/\.supp$/i, '.sinf');
            archive.append(Buffer.from(plist.build(this.metadata), 'utf8'), {name: 'iTunesMetadata.plist'});
            archive.append(Buffer.from(this.signature, 'base64'), {name: signatureTargetPath});
            for (const entry of Object.values(entries)) {
                if (entry.isDirectory || entry.name === 'iTunesMetadata.plist' || entry.name === 'PastelMetadata.plist' || entry.name === signatureTargetPath) continue;
                const stream = await readZip.stream(entry.name);
                archive.append(stream, {name: entry.name});
            }
            await archive.finalize();
            await finished(output);
            success = true;
        } catch (error) {
            if (error && error.prefix) throw error;
            const e = new Error(t('sign_failed', {message: error.message}));
            e.prefix = 'SIGN';
            throw e;
        } finally {
            if (readZip) await readZip.close().catch(() => {
            });
            if (!success) await fsPromises.unlink(tempIpaPath).catch(() => {
            });
        }
        await fsPromises.rename(tempIpaPath, ipaPath);
        console.log(t('sign_ok'));
    }

    // 「不再更新」是一个下载后的独立步骤：先完成与普通 IPA 完全相同的
    // 校验和签名，再从最终归档中移除 App Store 元数据。这样不会改变
    // Apple 的购买、下载或签名输入路径，也不会以自定义元数据替代它。
    async removeAppStoreMetadata(ipaPath) {
        const tempIpaPath = ipaPath + '.metadata.tmp';
        let readZip;
        let success = false;
        try {
            readZip = new StreamZip.async({file: ipaPath});
            const entries = await readZip.entries();
            if (!entries['iTunesMetadata.plist']) return;

            const output = createWriteStream(tempIpaPath);
            const archive = archiver('zip', {zlib: {level: 1}});
            archive.pipe(output);
            for (const entry of Object.values(entries)) {
                if (entry.isDirectory || entry.name === 'iTunesMetadata.plist') continue;
                const stream = await readZip.stream(entry.name);
                archive.append(stream, {name: entry.name});
            }
            await archive.finalize();
            await finished(output);
            success = true;
        } catch (error) {
            const e = new Error(t('sign_failed', {message: error.message}));
            e.prefix = 'SIGN';
            throw e;
        } finally {
            if (readZip) await readZip.close().catch(() => {
            });
            if (!success) await fsPromises.unlink(tempIpaPath).catch(() => {
            });
        }
        await fsPromises.rename(tempIpaPath, ipaPath);
    }
}
