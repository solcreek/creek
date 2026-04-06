// Type-level tests for useLiveQuery overloads.
// Uses expectTypeOf to verify compile-time type narrowing.
// These don't call hooks — they only check the function signatures.

import { expectTypeOf, describe, test } from "vitest";
import type { LiveQueryResult } from "./react.js";

describe("LiveQueryResult type narrowing", () => {
  test("HasInitial=true: data is T", () => {
    type Result = LiveQueryResult<string[], true>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[]>();
  });

  test("HasInitial=false: data is T | null", () => {
    type Result = LiveQueryResult<string[], false>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | null>();
  });

  test("HasInitial=true: mutate optimistic prev is T", () => {
    type Result = LiveQueryResult<number[], true>;
    type MutateFn = Result["mutate"];
    // Extract the optimistic callback parameter type
    type OptimisticFn = Exclude<Parameters<MutateFn>[1], undefined>;
    type PrevParam = Parameters<OptimisticFn>[0];
    expectTypeOf<PrevParam>().toEqualTypeOf<number[]>();
  });

  test("HasInitial=false: mutate optimistic prev is T | null", () => {
    type Result = LiveQueryResult<number[], false>;
    type MutateFn = Result["mutate"];
    type OptimisticFn = Exclude<Parameters<MutateFn>[1], undefined>;
    type PrevParam = Parameters<OptimisticFn>[0];
    expectTypeOf<PrevParam>().toEqualTypeOf<number[] | null>();
  });

  test("default HasInitial is false", () => {
    type Result = LiveQueryResult<string[]>;
    expectTypeOf<Result["data"]>().toEqualTypeOf<string[] | null>();
  });

  test("mutate accepts MutateRequest object", () => {
    type Result = LiveQueryResult<string[], true>;
    type MutateFn = Result["mutate"];
    type FirstArg = Parameters<MutateFn>[0];
    // Should accept both function and MutateRequest
    expectTypeOf<() => Promise<void>>().toMatchTypeOf<FirstArg>();
    expectTypeOf<{ method: "POST"; path: string; body: unknown }>().toMatchTypeOf<FirstArg>();
  });

  test("isLoading and isConnected are boolean", () => {
    type Result = LiveQueryResult<unknown>;
    expectTypeOf<Result["isLoading"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Result["isConnected"]>().toEqualTypeOf<boolean>();
  });
});
