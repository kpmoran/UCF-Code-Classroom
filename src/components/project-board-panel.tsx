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
  createMissingProjectBoards,
  setProjectBoardEnabled,
} from "@/lib/projects/actions";

/**
 * Project board management for staff.
 *
 * The backfill is the point of this panel, not an afterthought. An assignment is
 * usually already running before anyone decides they want boards — repositories
 * exist, students have accepted — and provisioning only creates a board at accept
 * time. Without a way to fill the gap, turning the setting on would silently apply
 * to nobody who had already started.
 */
export function ProjectBoardPanel({
  assignmentId,
  orgLogin,
  enabled,
  withBoard,
  missing,
  notProvisioned,
}: {
  assignmentId: string;
  orgLogin: string;
  enabled: boolean;
  withBoard: number;
  missing: number;
  notProvisioned: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(
    action: (
      fd: FormData,
    ) => Promise<
      { ok: true; data: { queued: number } } | { ok: false; error: string }
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

      const { queued } = result.data;
      setMessage(
        queued > 0
          ? `Creating ${queued} board${queued === 1 ? "" : "s"}. They appear as each one is made.`
          : "No boards were missing.",
      );
      router.refresh();
    });
  }

  return (
    <section aria-label="Project boards">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle>Project boards</CardTitle>
              <CardDescription>
                One board per student, owned by{" "}
                <span className="font-mono text-xs">{orgLogin}</span> and linked
                to their repository. It has to be organization-owned — GitHub
                only links a board to a repository owned by the same account, so
                a student cannot attach one of their own.
              </CardDescription>
            </div>
            <Badge tone={enabled ? "success" : "neutral"} className="shrink-0">
              {enabled ? "on" : "off"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat value={withBoard} label="With a board" tone="ok" />
            <Stat value={missing} label="Ready, no board yet" />
            <Stat value={notProvisioned} label="No repository yet" />
          </div>

          <p className="text-sm text-muted">
            This button covers every repository, not only the ones without a
            board: the second half of the work is granting access, and a board
            nobody can open is indistinguishable from a missing one — GitHub
            shows what you cannot see as a 404 rather than as forbidden. Boards
            are made a couple a minute to stay inside the request budget, so a
            large class finishes over several minutes.{" "}
            {notProvisioned > 0
              ? "Repositories that do not exist yet get a board when they are provisioned, so the last column needs nothing from you."
              : "Every repository that exists can have a board."}
          </p>

          {error ? (
            <p
              role="alert"
              className="text-sm rounded-md bg-danger-subtle text-danger px-3 py-2"
            >
              {error}
            </p>
          ) : null}
          {message ? <p className="text-sm text-muted">{message}</p> : null}
        </CardContent>

        <CardFooter className="flex justify-between gap-3 flex-wrap">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(setProjectBoardEnabled, {
                enabled: enabled ? "false" : "true",
              })
            }
          >
            {enabled ? "Turn off" : "Turn on"}
          </Button>

          {/*
           * Offered whenever boards are on, not only when some are missing. Creating
           * is half the job; the other half is granting access, and a board created
           * before that step existed is invisible to everyone and reads as a 404.
           * Hiding this once every repository had a board would hide the only way to
           * fix exactly that.
           */}
          {enabled ? (
            <Button
              type="button"
              variant="accent"
              disabled={pending}
              onClick={() => run(createMissingProjectBoards)}
            >
              {pending
                ? "Working…"
                : missing > 0
                  ? `Create ${missing} missing, re-share ${withBoard}`
                  : `Repair access on ${withBoard} board${withBoard === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </section>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: "ok";
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div
        className={`text-2xl font-semibold tabular-nums ${tone === "ok" ? "text-success" : ""}`}
      >
        {value}
      </div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}
