#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { submitReport, reportReceipt, resolveReportContext, executorInbox } from "./lib/主动回传.mjs";

const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const context = process.argv.includes("--context") && value("--context");
if (!context) throw new Error("需要 --context 指定本轮回传绑定");
const schema = { type: "object", properties: {
  request_id: { type: "string", description: "派工交付说明中的本轮请求号" },
  report_key: { type: "string" }, status: { type: "string", enum: ["completed", "blocked", "needs_decision", "progress"] },
  summary: { type: "string", maxLength: 1500 }, level: { type: "string", enum: ["subtask", "milestone", "batch", "review", "final"] },
  checks: { type: "array", items: { type: "string" } }, unresolved: { type: "array", items: { type: "string" } }
}, required: ["report_key", "status", "summary"], additionalProperties: false };
if (!process.argv.includes("--mcp")) {
  const bound = resolveReportContext(context, process.argv.includes("--request-id") ? value("--request-id") : undefined);
  const result = process.argv.includes("--inbox") ? executorInbox(bound) : process.argv.includes("--ack") ? executorInbox(bound, value("--ack")) : process.argv.includes("--receipt") ? reportReceipt(bound, value("--receipt")) : submitReport(bound, JSON.parse(fs.readFileSync(value("--input"), "utf8")));
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    const send = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    try {
      if (request.method === "initialize") send({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "claude-bridge-report", version: "1.0.0" } });
      else if (request.method === "ping") send({});
      else if (request.method === "tools/list") send({ tools: [
        { name: "report", description: "回传当前委派的交付或阻塞；收据只证明保存，不代表Codex验收。相同编号可重试，修订内容换新编号。", inputSchema: schema },
        { name: "receipt", description: "查询精确回传是否已由主控处理；通常无需轮询。", inputSchema: { type: "object", properties: { report_id: { type: "string" }, request_id: { type: "string" } }, required: ["report_id"], additionalProperties: false } },
        { name: "inbox", description: "阶段边界或交付前读取本轮补充证据，不轮询。读取后结合任务判断，用ack确认采用。", inputSchema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"], additionalProperties: false } },
        { name: "ack", description: "确认已读取并采用本轮指定证据，不代表任务已经完成。", inputSchema: { type: "object", properties: { request_id: { type: "string" }, evidence_id: { type: "string" } }, required: ["request_id", "evidence_id"], additionalProperties: false } }
      ] });
      else if (request.method === "tools/call") {
        const { name, arguments: args = {} } = request.params;
        if (!["report", "receipt", "inbox", "ack"].includes(name)) throw new Error("未知回传工具");
        const bound = resolveReportContext(context, args.request_id);
        const result = name === "inbox" ? executorInbox(bound) : name === "ack" ? executorInbox(bound, args.evidence_id) : name === "report" ? submitReport(bound, args) : reportReceipt(bound, args.report_id);
        send({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "不支持的方法" } }) + "\n");
    } catch (error) { send({ isError: true, content: [{ type: "text", text: error.message }] }); }
  }
}
