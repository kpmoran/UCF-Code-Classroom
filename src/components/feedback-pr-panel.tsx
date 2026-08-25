"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  createMissingFeedbackPrs,
  setFeedbackPrEnabled,
} from "@/lib/feedback/actions";

/**
 * Feedback pull request management for staff.
 *
 * The counts are split three ways because the difference matters: a repository with
 * no PR because the student has not pushed is *waiting*, not broken, and conflating
 * the two would send an instructor chasing a problem that does not exist.
 */
export function FeedbackPrPanel({
  assignmentId,
  enabled,
  withPr,
  pushedWithoutPr,
  awaitingFirstPush,
}: {
  assignmentId: string;
  enabled: boolean;
  withPr: number;
  pushedWithoutPr: number;
  awaitingFirstPush: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(
    action: (
      fd: FormData,
    ) => Promise<
      | { ok: true; data: { queued?: number; notPushed?: number } }
      | { ok: false; error: string }
    >,
    extra: Record<string, string> = {},
  ) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("assignmentId", assignmentId);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);

      const result = await action(fd);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      const queued = result.data.queued ?? 0;
      const notPushed = result.data.notPushed;
      const parts: string[] = [];
      if (queued > 0) {
        parts.push(`Opening ${queued} pull request${queued === 1 ? "" : "s"}.`);
      } else {
        parts.push("No pull requests were missing.");
      }
      if (notPushed && notPushed > 0) {
        parts.push(
          `${notPushed} student${notPushed === 1 ? " has" : "s have"} not pushed yet — ` +
            "theirs open automatically on first push.",
        );
      }
      setMessage(parts.join(" "));
      router.refresh();
    });
  }

  return (
    <section aria-label="Feedback pull requests">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle>Feedback pull requests</CardTitle>
              <CardDescription>
                A “Feedback” pull request pinned to the assignment’s starting
                state, so its diff shows the student’s whole submission and you
                can comment line by line.
              </CardDescription>
            </div>
            <Badge tone={enabled ? "success" : "neutral"}>
              {enabled ? "on" : "off"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {error ? (
            <p
              role="alert"
              className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2"
            >
              {error}
            </p>
          ) : null}
          {message ? (
            <p
              role="status"
              className="text-sm rounded-md bg-success-subtle text-success px-3 py-2"
            >
              {message}
            </p>
          ) : null}

          {enabled ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3 text-sm">
                <Stat
                  label="With a pull request"
                  value={withPr}
                  tone="success"
                />
                <Stat
                  label="Pushed, awaiting one"
                  value={pushedWithoutPr}
                  tone={pushedWithoutPr > 0 ? "warning" : "neutral"}
                />
                <Stat
                  label="Not pushed yet"
                  value={awaitingFirstPush}
                  tone="neutral"
                />
              </div>

              <p className="text-xs text-muted">
                A pull request can only be opened once a student has pushed —
                GitHub refuses one with no changes to show. Repositories in the
                last column are waiting for that, not broken.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">
              Turning this on records a baseline in each repository and opens a
              pull request for every student who has already pushed.
            </p>
          )}
        </CardContent>

        <CardFooter className="flex justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(setFeedbackPrEnabled, { enabled: enabled ? "false" : "true" })
            }
          >
            {enabled ? "Turn off" : "Turn on"}
          </Button>
          {enabled ? (
            <Button
              variant="accent"
              disabled={pending || pushedWithoutPr === 0}
              onClick={() => run(createMissingFeedbackPrs)}
            >
              {pending
                ? "Queueing…"
                : `Open ${pushedWithoutPr} missing pull request${pushedWithoutPr === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "neutral";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : "text-foreground";
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
