# Surfaces the judge does not cover (the unverified ledger)

On the same terms as the audit report, the surfaces below are **outside** the parity judge's evidence.
Phase 17's done-gate does not depend on them, and the final delivery report has to restate this
boundary:

1. **Real provider behavior**: every scenario uses a local SSE fixture or an empty environment, and
   nothing verifies the behavior, rate limiting or actual billing of a real Anthropic, OpenAI or DS4
   endpoint.
2. **DS4 performance on real hardware**: KV cache hit rate, prefill, tokens per second and latency
   over a long session — there are neither DS4 weights nor the hardware.
3. **Long-running behavior**: a soak test over days, the rate of missed cron runs, a storm of MCP
   notifications, and contention on the inbox across processes.
4. **Visual and interaction detail in the web UI**: the judge only smoke-tests the HTTP endpoints, and
   the S series contains no pixel comparison. The same holds for TUI layout, where what is captured is
   the text rather than the rendered frame.
5. **Credential flows**: the real /login OAuth flow with its browser interaction. Only locally
   testable behavior, such as refusing an inline key, is verified.
6. **Platforms**: verified on Linux locally only; macOS and Windows are out of scope.
7. **Timing-sensitive concurrent interleavings**: the judge asserts steady-state output and file
   structure, and cannot prove every interleaving agrees; the ordering-contract cases among the
   characterization tests stand in for that.
