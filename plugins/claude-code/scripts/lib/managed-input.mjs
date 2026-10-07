// 终端导航序列只改变视图或光标位置，不代表用户提交了指令。
export function activeTerminalInput(value) {
  return String(value)
    // Windows Terminal 的焦点通知、光标位置回报是终端协议，不是用户键入。
    .replace(/\x1b\[[IO]/g, "")
    .replace(/\x1b\[\d+;\d+R/g, "")
    .replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "")
    .replace(/\x1b\[[0-9;?]*[ABCDHFKJ]/g, "")
    .replace(/\x1b\[(?:1|4|5|6)~/g, "")
    .replace(/\x1b\[\?\d+[hl]/g, "");
}

export function hasHumanIntervention(value) {
  const input = activeTerminalInput(value);
  return [...input].some((char) => char === "\r" || char === "\x03" || char === "\x1b" ||
    char === "\x15" || char === "\x7f" || char === "\b" || /[^\x00-\x1f\x7f]/u.test(char));
}
