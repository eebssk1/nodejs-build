"""Avoid GCC PGO folding a 64-bit seed increment into a 32-bit TLS relocation."""

from pathlib import Path
import sys


if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/fix-abseil-tls.py NODE_SOURCE_DIR")

header = Path(sys.argv[1]) / "deps/v8/third_party/abseil-cpp/absl/container/internal/raw_hash_set.h"
if not header.is_file():
    print("Abseil TLS workaround: header absent; skipping")
    raise SystemExit(0)

# Match only the affected function, not other TLS variables in this header.
old = """inline size_t NextSeedBaseNumber() {
  thread_local size_t seed = reinterpret_cast<uintptr_t>(&seed);"""
new = """inline size_t NextSeedBaseNumber() {
  // Prevent GCC PGO from folding the seed increment into a TPOFF32 addend.
  // Keep the same initial value; the register barrier emits no instructions.
  thread_local size_t seed = [] {
    size_t address = reinterpret_cast<uintptr_t>(&seed);
#if defined(__GNUC__) && !defined(__clang__)
    __asm__("" : "+r"(address));
#endif
    return address;
  }();"""

text = header.read_text(encoding="utf-8")
if new in text:
    print("Abseil TLS workaround: already applied")
elif old not in text:
    print("Abseil TLS workaround: affected initializer absent; skipping")
elif text.count(old) != 1:
    raise SystemExit("Abseil TLS workaround: ambiguous initializer; refusing to patch")
else:
    header.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("Abseil TLS workaround: applied before PGO generation")
