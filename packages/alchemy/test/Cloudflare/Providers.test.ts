import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as Cloudflare from "@/Cloudflare";
import {
  makeAuthRetryBudget,
  makeCloudflareRetryFactory,
} from "@/Cloudflare/Providers.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  Forbidden,
  TooManyRequests,
  Unauthorized,
} from "@distilled.cloud/cloudflare";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";

it.live(
  "building the Cloudflare provider layers should not fail for unknown profile",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(Cloudflare.providers());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, {}),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: false,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
            }),
          ),
          Layer.sync(ArtifactStore, createArtifactStore),
          NodeServices.layer,
          FetchHttpClient.layer,
        ),
      ),
    ),
);

describe("cloudflareRetryFactory", () => {
  // The factory runs once per API call; `while` is evaluated once per
  // failure, so each `true` below corresponds to one retry attempt. Each
  // test gets a fresh auth-retry budget so they stay independent.
  const makePolicy = Effect.gen(function* () {
    const lastError = yield* Ref.make<unknown>(undefined);
    return makeCloudflareRetryFactory(makeAuthRetryBudget())(lastError);
  });

  it.effect(
    "never retries Cloudflare's auth-failure ban (429 code 10502)",
    () =>
      Effect.gen(function* () {
        const policy = yield* makePolicy;
        const ban = new TooManyRequests({
          message: "Too many authentication failures. Please try again later.",
        });
        expect(policy.while?.(ban)).toBe(false);
      }),
  );

  it.effect("retries ordinary throttling (429 code 10429)", () =>
    Effect.gen(function* () {
      const policy = yield* makePolicy;
      const throttle = new TooManyRequests({
        message:
          "Rate limited. Please wait and consider throttling your request speed",
      });
      expect(policy.while?.(throttle)).toBe(true);
    }),
  );

  it.effect(
    "caps 'Authentication error' retries — a bad credential must not trip the auth-failure ban",
    () =>
      Effect.gen(function* () {
        const policy = yield* makePolicy;
        const authError = new Unauthorized({
          message: "Authentication error",
        });
        expect(policy.while?.(authError)).toBe(true);
        expect(policy.while?.(authError)).toBe(true);
        expect(policy.while?.(authError)).toBe(false);
      }),
  );

  it.effect("the auth-retry budget is shared across concurrent API calls", () =>
    Effect.gen(function* () {
      const factory = makeCloudflareRetryFactory(makeAuthRetryBudget());
      const policyA = factory(yield* Ref.make<unknown>(undefined));
      const policyB = factory(yield* Ref.make<unknown>(undefined));
      const authError = new Unauthorized({
        message: "Authentication error",
      });
      expect(policyA.while?.(authError)).toBe(true);
      expect(policyB.while?.(authError)).toBe(true);
      // Budget exhausted process-wide: neither call may retry again,
      // otherwise a startup fan-out multiplies auth failures past
      // Cloudflare's ban threshold.
      expect(policyA.while?.(authError)).toBe(false);
      expect(policyB.while?.(authError)).toBe(false);
    }),
  );

  it("the auth-retry budget refills after a quiet window", () => {
    const budget = makeAuthRetryBudget(2, 30_000);
    expect(budget.take(0)).toBe(true);
    expect(budget.take(1_000)).toBe(true);
    expect(budget.take(2_000)).toBe(false);
    expect(budget.take(30_000)).toBe(true);
  });

  it.effect(
    "the auth-retry cap is shared across both misleadingly-transient auth messages",
    () =>
      Effect.gen(function* () {
        const policy = yield* makePolicy;
        const unableToAuth = new Forbidden({
          message: "Unable to authenticate request",
        });
        const authError = new Forbidden({ message: "Authentication error" });
        expect(policy.while?.(unableToAuth)).toBe(true);
        expect(policy.while?.(authError)).toBe(true);
        expect(policy.while?.(unableToAuth)).toBe(false);
      }),
  );

  it.effect(
    "keeps the normal transient budget for Forbidden 'internal error'",
    () =>
      Effect.gen(function* () {
        const policy = yield* makePolicy;
        const internal = new Forbidden({ message: "internal error" });
        for (let i = 0; i < 10; i++) {
          expect(policy.while?.(internal)).toBe(true);
        }
      }),
  );

  it.effect("does not retry unambiguous credential failures", () =>
    Effect.gen(function* () {
      const policy = yield* makePolicy;
      const invalidToken = new Unauthorized({ message: "Invalid API Token" });
      expect(policy.while?.(invalidToken)).toBe(false);
    }),
  );
});
