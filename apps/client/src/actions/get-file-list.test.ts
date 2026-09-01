import { assertEquals } from "@std/assert";
import {
  getFileListItemKey,
  normalizeFileListText,
  parsePathSegments,
  planNavigation,
} from "./get-file-list.ts";

Deno.test("parsePathSegments splits forward/back slashes and drops 首页", () => {
  assertEquals(parsePathSegments("Movies/2024"), ["Movies", "2024"]);
  assertEquals(parsePathSegments("Movies\\2024\\a.mp4"), [
    "Movies",
    "2024",
    "a.mp4",
  ]);
  assertEquals(parsePathSegments("首页/Movies"), ["Movies"]);
  assertEquals(parsePathSegments(""), []);
});

Deno.test("normalizeFileListText collapses whitespace", () => {
  assertEquals(normalizeFileListText("  a   b  "), "a b");
  assertEquals(normalizeFileListText(null), "");
});

Deno.test("getFileListItemKey joins identity fields", () => {
  const item = {
    name: "a.mp4",
    size: "1.2GB",
    type: "视频",
    updatedAt: "2026-06-07",
  };
  assertEquals(
    getFileListItemKey(item),
    "a.mp4\u00001.2GB\u0000视频\u00002026-06-07",
  );
});

Deno.test("planNavigation: already at target → none", () => {
  assertEquals(planNavigation(["Movies", "2024"], ["Movies", "2024"]), {
    action: "none",
  });
});

Deno.test("planNavigation: at root, target nested → navigate remaining", () => {
  assertEquals(planNavigation([], ["Movies", "2024"]), {
    action: "navigate",
    segments: ["Movies", "2024"],
  });
});

Deno.test("planNavigation: prefix of target → navigate remaining", () => {
  assertEquals(planNavigation(["Movies"], ["Movies", "2024"]), {
    action: "navigate",
    segments: ["2024"],
  });
});

Deno.test("planNavigation: divergent path → reset then navigate", () => {
  assertEquals(planNavigation(["Docs"], ["Movies"]), {
    action: "reset",
    segments: ["Movies"],
  });
});

Deno.test("planNavigation: at root, target empty → none", () => {
  assertEquals(planNavigation([], []), { action: "none" });
});

Deno.test("planNavigation: nested current, target empty → reset to root", () => {
  assertEquals(planNavigation(["Movies"], []), {
    action: "reset",
    segments: [],
  });
});
