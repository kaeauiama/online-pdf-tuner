// M4: オフライン対応(Service Worker)・ファイルハンドラ・アプリとしてのインストール。
// ファイルハンドラ(「プログラムから開く」)とインストールの案内は Chromium 系(Chrome / Edge)のみ(D-014)。
import { $, type Ui } from './ui.ts';

interface LaunchParams {
  readonly files: readonly { getFile(): Promise<File> }[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupPwa(ui: Ui, addFiles: (files: File[]) => Promise<void>): void {
  // 「プログラムから開く」で渡された PDF を読み込む
  const launchQueue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  launchQueue?.setConsumer(async (params) => {
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    if (files.length > 0) await addFiles(files);
  });

  // アプリとしてインストールできるときだけ、ボタンを出す
  const installButton = $<HTMLButtonElement>('#install-app');
  let deferred: BeforeInstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installButton.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    installButton.hidden = true;
    ui.toast('アプリとしてインストールしました。オフラインでも使え、PDF を右クリックして「プログラムから開く」で開けます。');
  });

  // 開発サーバーでは Service Worker を使わない(古いファイルが残って開発しにくくなるため)
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void registerServiceWorker();
}

async function registerServiceWorker(): Promise<void> {
  const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  const banner = $<HTMLElement>('#update-banner');
  const showUpdate = (worker: ServiceWorker) => {
    banner.hidden = false;
    $<HTMLButtonElement>('#update-apply').onclick = () => worker.postMessage('skip-waiting');
  };
  // 初回のインストールでは知らせない(すでに最新)。更新のときだけ知らせる
  if (registration.waiting && navigator.serviceWorker.controller) showUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || banner.hidden) return;
    reloading = true;
    window.location.reload();
  });
}
