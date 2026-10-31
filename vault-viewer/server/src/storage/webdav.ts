// WebDAV: Nextcloud, ownCloud, Koofr, Synology, InfiniCLOUD and anything else that speaks WebDAV.
//   config.url       the WebDAV folder the account may write to, e.g.
//                    https://cloud.example.com/remote.php/dav/files/<user>/   (Nextcloud)
//                    https://app.koofr.net/dav/Koofr/                         (Koofr)
//   config.username  / config.password (use an app password where the service has them)
//   config.folder    sub-folder for the vaults (created if missing), default "隨身密閱"
// Layout: <url>/<folder>/<vaultId>/<00000.bin, 00001.bin, …>; refs are paths relative to <folder>.

import { encodePath, httpError, partName, StorageError, type Adapter, type AdapterDeps, type StorageProfile } from './types';

const HINTS: Record<number, string> = {
  401: '帳號或密碼不正確（Nextcloud 請使用「應用程式密碼」）',
  403: '這個帳號沒有寫入權限',
  404: '找不到這個 WebDAV 網址，請確認網址是否完整',
  405: '這個網址不接受 WebDAV 操作，請確認網址是否完整',
  507: '雲端空間已滿',
};

function basicAuth(user: string, pass: string) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return `Basic ${btoa(s)}`;
}

export function webdavAdapter(p: StorageProfile, d: AdapterDeps): Adapter {
  const base = p.config.url.replace(/\/+$/, '');
  const folder = encodePath(p.config.folder || '隨身密閱');
  const root = `${base}/${folder}`;
  const auth = basicAuth(p.config.username ?? '', p.config.password ?? '');
  const req = async (method: string, url: string, init: { body?: ArrayBuffer | string; headers?: Record<string, string> } = {}) => {
    try {
      return await d.fetch(url, { method, body: init.body, headers: { authorization: auth, ...init.headers } });
    } catch (e) {
      throw new StorageError(`連不到 WebDAV 伺服器（${(e as Error).message}）。請確認網址正確、伺服器可以從網際網路連到。`);
    }
  };
  const mkcol = async (url: string) => {
    const res = await req('MKCOL', `${url}/`);
    // 405 = already exists
    if (!res.ok && res.status !== 405) throw await httpError('建立 WebDAV 資料夾', res, HINTS);
  };
  const ensureRoot = async () => {
    // Create each level of the folder, so "公司/隨身密閱" works too.
    let url = base;
    for (const seg of folder.split('/')) await mkcol((url = `${url}/${seg}`));
  };

  return {
    async test() {
      await ensureRoot();
      const probe = `${root}/.vault-viewer-test`;
      const body = `ok ${new Date(d.now()).toISOString()}`;
      let res = await req('PUT', probe, { body, headers: { 'content-type': 'text/plain' } });
      if (!res.ok) throw await httpError('寫入測試檔', res, HINTS);
      res = await req('GET', probe);
      if (!res.ok || (await res.text()) !== body) throw new StorageError('寫入的測試檔讀回來不一樣，這個 WebDAV 伺服器可能不支援');
      await req('DELETE', probe);
      return `可以讀寫「${decodeURIComponent(folder)}」資料夾`;
    },

    async prepare(vaultId) {
      await ensureRoot();
      await mkcol(`${root}/${vaultId}`);
      return vaultId;
    },

    async put(container, vaultId, part, data) {
      const rel = `${container || vaultId}/${partName(part)}`;
      let res = await req('PUT', `${root}/${rel}`, { body: data, headers: { 'content-type': 'application/octet-stream' } });
      if (res.status === 409 || res.status === 404) {
        // the folder went missing (deleted by hand?): make it again and retry once
        await mkcol(`${root}/${container || vaultId}`).catch(async () => {
          await ensureRoot();
          await mkcol(`${root}/${container || vaultId}`);
        });
        res = await req('PUT', `${root}/${rel}`, { body: data, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (!res.ok) throw await httpError('上傳到 WebDAV', res, HINTS);
      return rel;
    },

    async get(ref, range) {
      return req('GET', `${root}/${ref}`, { headers: range ? { range } : {} });
    },

    async remove(container) {
      if (!container) return [];
      const res = await req('DELETE', `${root}/${container}/`);
      if (!res.ok && res.status !== 404) throw await httpError('刪除 WebDAV 上的檔案', res, HINTS);
      return [];
    },
  };
}
