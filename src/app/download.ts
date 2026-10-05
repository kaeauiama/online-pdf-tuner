// 生成したファイルを保存させる。blob: URL を使うだけで、通信は発生しない。
export function downloadBytes(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // ダウンロードの開始を待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
