# 安装、升级与卸载

## 前提

- SillyTavern 1.14.x–1.18.x
- Node.js 18+
- 对 SillyTavern 目录有写权限

## 安装

```bash
node scripts/install.mjs --st /path/to/SillyTavern
```

脚本验证 `package.json` 版本，并复制：

- UI：`public/scripts/extensions/third-party/st-image-atelier`
- 服务端：`plugins/st-image-atelier`

已有目标默认拒绝覆盖。升级前自行备份数据，然后：

```bash
node scripts/install.mjs --st /path/to/SillyTavern --force
```

如希望脚本修改 `config.yaml`，显式传：

```bash
node scripts/install.mjs --st /path/to/SillyTavern --enable-server-plugins
```

该模式先创建带时间戳的 `config.yaml.stia-backup-*`，再把 `enableServerPlugins` 改为 `true`。不传该参数时脚本只检查并提示。

## 重启

在 SillyTavern 根目录：

```bash
npm start
```

Termux 常见方式同样是 `npm start`；Windows 启动脚本用户也可关闭原窗口后重新运行 `Start.bat`。

## 验证

```bash
node scripts/verify-install.mjs --st /path/to/SillyTavern
```

进入 ST 后，扩展菜单应出现「✦ Image Atelier」，打开后健康状态应显示「服务端已连接」。

## 首次配置

1. 填写 Base URL。
2. 填写 API Key。
3. 点击「拉取模型」；失败时可手动输入模型。
4. 点击「测试连接」。
5. 保存设置。
6. 自动生图默认关闭，建议先用 mock/低成本模型手动验证。

## 卸载

```bash
node scripts/uninstall.mjs --st /path/to/SillyTavern
```

默认只移除 UI 和 Server Plugin 代码，保留用户数据。确认不要历史图片和配置时添加 `--purge-data`；数据删除不可恢复。

回滚 `config.yaml` 时，把对应 `config.yaml.stia-backup-*` 复制回 `config.yaml` 后重启。
