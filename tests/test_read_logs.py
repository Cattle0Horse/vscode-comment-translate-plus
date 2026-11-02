import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "read_logs.py"


class ReadLogsTests(unittest.TestCase):
  def run_cli(self, events, *arguments, suffix=""):
    with tempfile.TemporaryDirectory(prefix="ctp-read-log-") as directory:
      path = Path(directory) / "events.jsonl"
      path.write_text("".join(json.dumps(event) + "\n" for event in events) + suffix, encoding="utf-8")
      return subprocess.run([sys.executable, str(SCRIPT), str(path), *arguments], capture_output=True, encoding="utf-8", check=False)

  def test_filters_combine_and_keep_recent_matching_events_without_payloads(self):
    events = [
      {"kind": "request", "taskId": "T1", "sessionId": "older", "file": "file:///guide.md", "failures": [{"code": "marker-invalid"}]},
      {"kind": "request", "taskId": "T1", "sessionId": "current", "file": "file:///guide.md", "requestId": "T1/R1", "timestamp": "2026-11-02T01:00:00Z", "failures": [{"code": "marker-invalid"}], "modelResponse": "private synthetic payload"},
      {"kind": "request", "taskId": "T1", "sessionId": "current", "file": "file:///guide.md", "requestId": "T1/R2", "timestamp": "2026-11-02T02:00:00Z", "failures": [{"code": "marker-invalid"}], "modelResponse": "private synthetic payload"},
      {"kind": "finish", "taskId": "T1", "sessionId": "current", "status": "complete"}
    ]
    result = self.run_cli(events, "--issues", "--session", "current", "--task", "T1", "--kind", "request", "--file", "guide.md", "--code", "marker-invalid", "--since", "2026-11-02T09:30:00+08:00", "--limit", "1")
    self.assertEqual(result.returncode, 0, result.stderr)
    records = [json.loads(line) for line in result.stdout.splitlines()]
    self.assertEqual([record["requestId"] for record in records], ["T1/R2"])
    self.assertNotIn("private synthetic payload", result.stdout)

  def test_full_evidence_and_statistics_preserve_recovered_request_failures(self):
    events = [
      {"kind": "request", "taskId": "T2", "failures": [{"code": "marker-invalid"}], "modelResponse": "synthetic response\nwith details"},
      {"kind": "diagnostic", "level": "error", "code": "parse-invalid"},
      {"kind": "finish", "taskId": "T2", "status": "complete"}
    ]
    full = self.run_cli(events, "--task", "T2", "--kind", "request", "--full")
    self.assertEqual(json.loads(full.stdout), events[0])
    stats = self.run_cli(events, "--issues", "--stats", "--limit", "1")
    self.assertEqual(stats.returncode, 0, stats.stderr)
    self.assertEqual(json.loads(stats.stdout)["errorCodes"], {"marker-invalid": 1, "parse-invalid": 1})
    self.assertEqual(json.loads(stats.stdout)["matched"], 2)

  def test_corrupt_records_fail_visibly_but_unfinished_tail_can_be_read_again(self):
    result = self.run_cli([{"kind": "start"}], suffix='not JSON\n{"kind":"finish"}\n')
    self.assertEqual(result.returncode, 1)
    self.assertIn("2", result.stderr)
    self.assertEqual([json.loads(line)["kind"] for line in result.stdout.splitlines()], ["start", "finish"])
    partial = self.run_cli([{"kind": "start"}], suffix='{"kind":')
    self.assertEqual(partial.returncode, 0)
    self.assertTrue(partial.stderr)
    self.assertEqual(json.loads(partial.stdout)["kind"], "start")


if __name__ == "__main__":
  unittest.main()
