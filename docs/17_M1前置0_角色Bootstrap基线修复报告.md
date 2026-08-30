# M1 前置 0：角色 Bootstrap 基线修复报告

状态：完成

日期：2026-08-28（Asia/Singapore）

基线：`codex/remote-trunk-port@417b5fe`

## 1. 裁决执行

本提交只修复 `character-bootstrap` 报告与审计方法，不重编码、不替换任何
角色 GLB。

旧报告把 Sharp 生成的临时 PNG 容器字节作为合同，记录 `pngBytes` 与
`pngSha256`。PNG 压缩器或元数据实现变化时，即使解码后的像素、KTX2、GLB、
几何、骨骼和动画完全相同，字节 SHA 仍可能漂移。

新报告格式升级到 v3：

- 临时派生项由 `derivativePngs` 改为 `derivativePixels`；
- 校验对象改为解码后的 RGBA8 像素：宽、高、4 通道、像素字节数和
  `pixelSha256`；
- PNG 容器大小、压缩字节和编码器元数据不再进入资产语义合同；
- 报告显式记录 Sharp、libvips 和 Basis JS/WASM 指纹；
- 新增 `--refresh-report`，只审计 shipped GLB 并原子重写报告，不重编码资产。

## 2. 未被弱化的强合同

以下字段仍按 exact equality 校验：

- reference/bootstrap GLB 字节数与 SHA-256；
- 运行时 KTX2 payload SHA、尺寸、mipmap 与 ETC1S/UASTC 模式；
- 源贴图字节数与 SHA-256；
- Meshopt 非图像 transport；
- semantic JSON、silhouette、三角面与 primitive；
- 21 关节骨骼和全部 animation contract/clip 名；
- 每角色与合计体积预算。

因此本修复只去除环境耦合的 PNG 容器表示，没有放宽资产、动画或画面要求。

## 3. 审计工具链

| 项 | 实测 |
|---|---|
| Sharp | `0.35.2` |
| libvips | `8.18.3` |
| Basis JS SHA-256 | `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1` |
| Basis WASM SHA-256 | `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a` |

锁文件要求 Sharp 0.35.2；施工前安装目录残留 0.34.5。依赖与 lock 对齐后，旧
报告测试恢复通过，进一步证明问题属于现场解码/编码工具链而非 GLB 漂移。
v3 仍按裁决落地，避免以后再出现匿名容器 SHA 失败。

## 4. 资产不变证据

| 资产 | 修复前后 SHA-256 |
|---|---|
| `kid-bootstrap.glb` | `ebedbd74c3ac28ad6c2be05453fd684bc9e5ef98951156a7ecdd8646f00a0077` |
| `villain-bootstrap.glb` | `91ad6c102194d06f6e4d6c5a8a7130e01dda42c5c0fa3ab1111c1942f0b9811f` |
| `police-bootstrap.glb` | `a429aee2b409052888ac59e6f808f9ac963a482eafac37d04f4cee6e6126837a` |

`git diff` 中没有 `public/models/characters/**`。报告仍统计三个 bootstrap 合计
4,785,296 B，相对声明参考模型节省 61.382%。

## 5. 验证

| 检查 | 结果 | 摘要 |
|---|---|---|
| `build_character_bootstrap.mjs --refresh-report` | 通过 | v3 报告原子生成，未写 GLB |
| `build_character_bootstrap.mjs --check` | 通过 | shipped GLB 与 v3 报告完全一致 |
| 定向 bootstrap 测试 | 通过 | 2/2 |
| `npm run lint` | 通过 | 退出码 0 |
| `npm test` | 通过 | 529/529，0 fail/skip/cancel |

前置 0 到此关闭；后续 Villain 施工以本提交为全绿基线。
