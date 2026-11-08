# VLESS 代理配置说明

本项目原使用 hysteria2（UDP）做代理，已改为 **VLESS**（TCP），
支持 WS / GRPC / TLS / REALITY 等全部主流组合。

---

## 环境变量

| 变量 | 说明 |
|---|---|
| `VLESS_URL` | **必填**。VLESS 节点链接，格式见下 |
| `USERS_JSON` | 用户列表（未变） |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | Telegram 通知（未变） |

未设置 `VLESS_URL` 时自动跳过代理，脚本照常运行（与原来 `HY2_URL` 行为一致）。

### GitHub Actions

在仓库 Settings -> Secrets 中配置 `VLESS_URL`。

### CircleCI

在项目 Environment Variables 中配置 `VLESS_URL`。

---

## 支持的节点链接格式

### 1. Cloudflare 隧道（推荐，本项目已验证）

```
vless://UUID@172.64.155.1:443?encryption=none&security=tls
  &sni=fr.ouodr.kdns.fr&fp=chrome&type=ws
  &host=fr.ouodr.kdns.fr&path=%2Fvless-ws#cf
```

`172.64.155.1` 可换成任意 CF 优选 IP。

### 2. REALITY + Vision

```
vless://UUID@server:20063?encryption=none&flow=xtls-rprx-vision
  &security=reality&sni=www.nazhumi.com&fp=firefox
  &pbk=PUBLIC_KEY&type=tcp#reality
```

### 3. gRPC over TLS

```
vless://UUID@server:8443?encryption=none&security=tls&type=grpc&serviceName=svc
```

### 4. 明文 WS（不推荐）

```
vless://UUID@server:80?encryption=none&type=ws&path=%2Fws
```

---

## 支持的 URL 参数

| 参数 | 对应 sing-box 字段 | 说明 |
|---|---|---|
| `security` | `tls.enabled` | `tls` / `reality` / 空 |
| `sni` / `peer` | `tls.server_name` | TLS SNI |
| `fp` | `tls.utls.fingerprint` | `chrome` / `firefox` / `safari` 等 |
| `alpn` | `tls.alpn` | 逗号分隔 |
| `allowInsecure` / `insecure` | `tls.insecure` | 跳过证书校验 |
| `pbk` | `tls.reality.public_key` | REALITY 公钥 |
| `sid` | `tls.reality.short_id` | REALITY shortId |
| `flow` | `flow` | 如 `xtls-rprx-vision` |
| `type` | `transport.type` | `ws` / `grpc` / `tcp` |
| `host` | `transport.headers.Host` | WS 的 Host 头 |
| `path` | `transport.path` | WS 路径 |
| `serviceName` | `transport.service_name` | gRPC 服务名 |

---

## 生成的本地代理

```
SOCKS5  127.0.0.1:1080
HTTP    127.0.0.1:1081
```

`action_renew.js` 通过 `HTTP_PROXY=socks5://127.0.0.1:1080` 使用它，
这部分代码原本就只解析协议/主机/端口，不区分 hy2 还是 vless，所以无需改动。

---

## 文件变更

| 文件 | 变更 |
|---|---|
| `.github/workflows/renew.yml` | hy2 -> VLESS（sing-box） |
| `.circleci/config.yml` | hy2 -> VLESS（sing-box） |
| `.gitignore` | `hy2-config.json`/`hysteria` -> `vless-config.json`/`sing-box` |

---

## 为什么用 sing-box 而不是别的客户端

- 单二进制，无依赖，GitHub Releases 直接下载
- 原生支持 VLESS + WS/TCP/GRPC/H2 + TLS/REALITY 全组合
- 自带 `check` 子命令，可在 CI 里先校验配置再启动

---

## 验证记录

```
yaml.safe_load(renew.yml)          -> OK
yaml.safe_load(config.yml)         -> OK
tracked files 中无 hy2/hysteria 残留  -> 通过

节点链接 -> sing-box 配置转换：
  CF-WS-TLS          sing-box check: OK
  REALITY-vision     sing-box check: OK
  WS-plain-port80    sing-box check: OK
  GRPC-tls           sing-box check: OK
  no-security-tcp    sing-box check: OK

端到端（本地源站 + 真实 CF 隧道 + 生成的配置）：
  生成配置  server=172.64.155.1:443 sni=fr.ouodr.kdns.fr ws_host=fr.ouodr.kdns.fr
  SOCKS5 1080  -> HTTP 200
  HTTP   1081  -> HTTP 200
  出口          ip=... colo=LAX
```