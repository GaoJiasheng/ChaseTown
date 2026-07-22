# Apple Loops 音乐来源与许可记录

> 适用产物：`public/audio/slow-drift-explore.m4a`、`public/audio/slow-drift-threat.m4a`
> 配套构建：`tools/audio_pipeline/build_adaptive_score.mjs`
> 记录日期：2026-07-22

## 许可依据

本项目使用随 GarageBand 安装的 Apple Loops 作为原创自适应配乐的制作素材。Apple 官方说明允许用户免版税地使用 Apple 及第三方 Audio Content 创作并分发自己的原创音乐作品或音频项目；不得把单个 audio loop 作为独立 loop、sample、sound effect 或 music bed 单独分发。

- 官方许可说明：[Using royalty-free loops in GarageBand with commercial work](https://support.apple.com/en-us/102034)
- 官方页面发布日期：2023-08-21
- 本仓库不包含、复制或单独分发下列 `.caf` 源 loop。
- 两个交付文件都是多个 loop 经重新编排、分层、剪辑、均衡、动态和响度母带处理后得到的完整原创游戏音乐 stem；任何单个源 loop 都不能从交付物中作为原始文件直接取得。

## 使用的源素材

所有素材来自本机构建环境的：

`/Library/Audio/Apple Loops/Apple/01 Hip Hop/`

| 素材 | 音乐属性 | 用途 | SHA-256 |
|---|---|---|---|
| `Slow Drift Ambient Synth.caf` | 101 BPM、4/4、Bb minor、32 beats | 探索氛围主体、追逐空间层、反转过门 | `3f403c7ca600af00fc95ee9e14e9c082788fa91a5d6782b022ad29a1863c82ec` |
| `Slow Drift Bass Synth.caf` | 101 BPM、4/4、Bb minor、32 beats | 探索低量脉冲、追逐中低频节奏 | `1a09204465a976f0f06e6b5cde8826a102850c22745fe60dc450a0ac40006830` |
| `Slow Drift Sub Bass.caf` | 101 BPM、4/4、Bb minor、64 beats | 两个 stem 的受控低频层 | `05e71a9f6f61f582c12faad42afbb9134360be072b0c31f486adc0ade7cd8f81` |
| `Slow Drift Beat.caf` | 101 BPM、4/4、keyless percussion、64 beats | 探索幽灵节奏纹理、追逐节奏主体 | `2b30e32187ff88fb7c767f6276673abc9fbf5436d3170d22501ae9ce77b8ddd4` |

构建脚本在渲染前会核对全部 SHA-256。GarageBand 音色库缺失或源文件发生变化时，构建立即失败，禁止静默替换成来源不明的音频。

## 原创编排说明

两个 stem 共享 101 BPM、4/4、Bb minor、64 beats 的 16 小节时间线，目标时长约 38.0198 秒，可在运行时同步启动并按危险值连续混音。

### Explore

- 不是单 loop 导出；实际使用 Ambient Synth、Bass Synth、Sub Bass、Beat 四个不同源素材。
- Ambient Synth 循环为 64 beats 后进行中频清理、立体声空间调整和周期性动态塑形。
- Bass Synth 与 Sub Bass 使用不同的长周期包络，建立“不完全静止”的潜行张力。
- Beat 只保留高频幽灵纹理，不能还原为原始鼓 loop。
- 取 Ambient Synth 的两拍尾部反转并重新滤波，制成第 8 小节附近的内部过门；它是作品编排的一部分，不作为独立音效交付。

### Threat

- 不是单 loop 导出；实际使用 Beat、Sub Bass、Bass Synth、Ambient Synth 四个不同源素材。
- Beat、Sub 与 Bass 采用不同周期的能量包络，在 16 小节内逐步推进并回到可无缝循环的初始能量。
- Ambient Synth 被收窄频段并降低音量，只提供追逐空间，不与探索 stem 的主题争抢。
- 总线包含轻量压缩、峰值限制与两遍 EBU R128 响度母带处理。

## 交付规格与门禁

| 项目 | Explore | Threat |
|---|---:|---:|
| 格式 | AAC-LC / M4A | AAC-LC / M4A |
| 采样率 | 48 kHz | 48 kHz |
| 声道 | Stereo | Stereo |
| 目标响度 | -22 LUFS | -20 LUFS |
| 目标 True Peak | 不高于 -1.5 dBTP | 不高于 -1.5 dBTP |
| 时间线 | 101 BPM / 64 beats | 101 BPM / 64 beats |

构建时自动检查：

1. 四个源文件的 SHA-256 与本记录一致。
2. 两个成品均为 AAC、48 kHz、双声道。
3. 响度偏差不超过 ±0.6 LU，True Peak 不高于 -1.35 dBTP。
4. 两个 stem 的容器时长差不超过 1 ms。
5. 解码后的循环边界不存在高幅度单采样跳变。
6. 解码后的可播放时间线严格等于 1,824,950 个 48 kHz sample；两个 stem 的采样起点和长度一致。
7. 满威胁建议混音（Explore gain `0.40`、Threat gain `0.94`）仍保留至少约 1.7 dB true-peak 余量。
8. `public/audio/adaptive-score-manifest.json` 记录实际输出哈希、响度、峰值、时长和边界指标。

自动门禁不能替代听感验收。接入游戏前仍必须使用耳机和手机扬声器各完成至少一次：单独循环、双 stem 同步叠加、0→1 危险混音、1→0 回落混音与连续十次循环检查。听到节拍错位、接缝、低频堆积或动态抽吸时必须回到编排脚本返工。
