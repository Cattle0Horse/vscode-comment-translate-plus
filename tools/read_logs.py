"""Filter Agent JSONL logs without loading the entire file or printing payloads by default."""

import argparse
import json
import sys
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path


def timestamp(value):
  try:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
      raise ValueError("timestamp needs a timezone")
    return parsed.astimezone(timezone.utc)
  except (ValueError, AttributeError) as error:
    raise argparse.ArgumentTypeError("时间需为带时区的 ISO 8601，例如 2026-11-02T08:00:00+08:00") from error


def positive(value):
  number = int(value)
  if number < 1:
    raise argparse.ArgumentTypeError("条数必须大于 0")
  return number


def error_codes(record):
  if record.get("kind") == "finish" and record.get("status") == "cancelled":
    return set()
  codes = {record["code"]} if isinstance(record.get("code"), str) else set()
  for failure in record.get("failures", []):
    if isinstance(failure, dict) and isinstance(failure.get("code"), str):
      codes.add(failure["code"])
  return codes


def matches(record, args):
  if args.issues and record.get("kind") == "finish" and record.get("status") == "cancelled":
    return False
  for key, expected in (("kind", args.kind), ("sessionId", args.session), ("taskId", args.task), ("requestId", args.request)):
    if expected and record.get(key) not in expected:
      return False
  if args.file and (not isinstance(record.get("file"), str) or args.file not in record["file"]):
    return False
  if args.code and not error_codes(record).intersection(args.code):
    return False
  if args.issues and not (
    record.get("failures") or record.get("status") in ("failed", "partial") or record.get("code") or record.get("level") in ("warning", "error")
  ):
    return False
  if args.since:
    try:
      if timestamp(record.get("timestamp")) < args.since:
        return False
    except argparse.ArgumentTypeError:
      return False
  return True


def summary(record):
  keys = (
    "timestamp", "sessionId", "kind", "file", "documentVersion", "languageId", "profileId", "model",
    "taskId", "requestId", "status", "level", "code", "total", "completed", "changed", "unchanged",
    "skipped", "count", "attempt", "httpRequests", "elapsedMs", "cancelled", "cancellationReason",
    "cancellationReasons", "nextBatchSize", "retryDelayMs", "detailsIncluded"
  )
  result = {key: record[key] for key in keys if key in record}
  codes = sorted(error_codes(record))
  if codes:
    result["errorCodes"] = codes
  if record.get("failures"):
    result["failures"] = [
      {key: failure[key] for key in ("id", "start", "code", "attempts") if key in failure}
      for failure in record["failures"] if isinstance(failure, dict)
    ]
  if record.get("candidates"):
    result["candidates"] = [
      {key: candidate[key] for key in ("id", "attempt", "code") if key in candidate}
      for candidate in record["candidates"] if isinstance(candidate, dict)
    ]
  return result


def main(argv=None):
  parser = argparse.ArgumentParser(description="筛选注释翻译+的 Agent JSONL 日志；默认返回最近 30 条匹配事件的精简摘要")
  parser.add_argument("path", type=Path, help="logFile 配置指向的文件")
  for name, help_text in (
    ("kind", "事件类型，如 request、finish、diagnostic"), ("session", "扩展实例 sessionId"),
    ("task", "taskId"), ("request", "requestId"), ("code", "顶层或失败项错误码")
  ):
    parser.add_argument("--" + name, action="append", help=help_text + "；可重复，同类取并集")
  parser.add_argument("--file", help="源文 URI 中的字面子串（相对路径请使用 /，URI 特殊字符需编码）")
  parser.add_argument("--since", type=timestamp, help="只看该时间及以后的事件，必须带时区")
  parser.add_argument("--issues", action="store_true", help="只看失败、部分失败、警告和有失败项的请求，包含后来恢复成功的请求")
  parser.add_argument("--limit", type=positive, default=30, help="最近匹配条数，默认 30；按文件顺序返回")
  mode = parser.add_mutually_exclusive_group()
  mode.add_argument("--full", action="store_true", help="输出完整事件，包括正文、实际请求和响应")
  mode.add_argument("--stats", action="store_true", help="统计全部匹配事件，不受 limit 限制；错误码按事件计数")
  args = parser.parse_args(argv)
  selected = deque(maxlen=args.limit)
  kinds, codes = Counter(), Counter()
  scanned = matched = invalid = 0
  try:
    with args.path.open(encoding="utf-8-sig") as stream:
      for line_number, line in enumerate(stream, 1):
        if not line.strip():
          continue
        scanned += 1
        try:
          record = json.loads(line)
          if not isinstance(record, dict) or not isinstance(record.get("kind"), str):
            raise ValueError("事件必须是含 kind 字符串的 JSON 对象")
          if "failures" in record and not isinstance(record["failures"], list):
            raise ValueError("failures 必须是数组")
        except ValueError as error:
          if isinstance(error, json.JSONDecodeError) and not line.endswith("\n"):
            print(f"第 {line_number} 行末尾 JSON 尚未完整写入，已略过；稍后可重读", file=sys.stderr)
          else:
            invalid += 1
            print(f"第 {line_number} 行无效：{error}", file=sys.stderr)
          continue
        if not matches(record, args):
          continue
        matched += 1
        if args.stats:
          kinds[record["kind"]] += 1
          codes.update(error_codes(record))
        else:
          selected.append(record if args.full else summary(record))
  except (OSError, UnicodeError) as error:
    print(f"无法读取日志：{error}", file=sys.stderr)
    return 1
  if args.stats:
    print(json.dumps({"scanned": scanned, "matched": matched, "invalid": invalid, "kinds": kinds, "errorCodes": codes}, ensure_ascii=False))
  else:
    for record in selected:
      print(json.dumps(record, ensure_ascii=False))
  return 1 if invalid else 0


if __name__ == "__main__":
  if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
  if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
  try:
    sys.exit(main())
  except BrokenPipeError:
    sys.exit(0)
