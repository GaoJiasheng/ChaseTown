import type { CaptureReason } from "./contracts.ts";

export interface FailureFeedback {
  readonly title: string;
  readonly explanation: string;
  readonly hint: string;
}

const FEEDBACK: Readonly<Record<CaptureReason, FailureFeedback>> = Object.freeze({
  "direct-contact": Object.freeze({
    title: "在走廊里被追上",
    explanation: "你和追捕者之间没有留下足够的遮挡与转角。",
    hint: "不要沿长直道硬跑；连续转过两个墙角，再选择藏身点。",
  }),
  "exposed-hide-entry": Object.freeze({
    title: "进柜动作被看见",
    explanation: "追捕者在柜门关闭前仍然保持着清晰视线。",
    hint: "先借墙角切断视线，确认情报变成“前往最后位置”后再进柜。",
  }),
  "unsafe-hide-exit": Object.freeze({
    title: "离柜时机太早",
    explanation: "柜门打开时，追捕者仍在附近搜索或重新确认目标。",
    hint: "先按住观察；等脚步远去、状态进入附近搜索后再离开。",
  }),
  "witnessed-hide-check": Object.freeze({
    title: "追捕者记住了这个柜子",
    explanation: "他亲眼看到你进入，因此直接检查了对应柜门。",
    hint: "对齐柜门时可移动取消；开门动作开始后就无法反悔。",
  }),
  "search-hide-check": Object.freeze({
    title: "证据把他带到了柜门前",
    explanation: "最后目击路径或奔跑声让这个柜子成为合理的搜索目标。",
    hint: "藏好前少走直线，必要时放慢脚步；窥视确认开门动作再判断。",
  }),
});

export function failureFeedback(reason: CaptureReason | null): FailureFeedback {
  return reason ? FEEDBACK[reason] : FEEDBACK["direct-contact"];
}
