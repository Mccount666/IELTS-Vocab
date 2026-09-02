// 真题词库 · Electron 桌面壳
// 职责：一个加载云端站点的浏览器窗口。登录态（cookie）与静态缓存由
// Electron 默认持久 session 自动保留，跨重启有效。
// 站点地址在 config.json 的 siteUrl，分发前改成正式域名重新 npm run dist 即可。

const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const SITE_URL = process.env.IELTS_SITE_URL || config.siteUrl;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "真题词库",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    backgroundColor: "#f6f5fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 站内跳转放行，外部链接一律交给系统浏览器，避免窗口被导航去别的网站
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SITE_URL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(SITE_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(SITE_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
