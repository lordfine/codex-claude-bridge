import { collectIteration } from "./lib/迭代采集.mjs";
const args = process.argv.slice(2), options = {};
const fields = { "--主控": "controller", "--起始": "since", "--截止": "until", "--输出": "output" };
try {
  for (let i = 0; i < args.length; i += 2) {
    if (!fields[args[i]] || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("参数须为 --主控 UUID、--起始/--截止 ISO时间 或 --输出 绝对目录");
    options[fields[args[i]]] = args[i + 1];
  }
  console.log(JSON.stringify(await collectIteration(options)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
