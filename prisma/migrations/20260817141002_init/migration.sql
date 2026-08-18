-- CreateEnum
CREATE TYPE "ClassroomRole" AS ENUM ('INSTRUCTOR', 'TA', 'STUDENT');

-- CreateEnum
CREATE TYPE "RepoVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "StudentPermission" AS ENUM ('PULL', 'PUSH', 'MAINTAIN', 'ADMIN');

-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('INDIVIDUAL', 'GROUP');

-- CreateEnum
CREATE TYPE "TeamNamingMode" AS ENUM ('STUDENT_CHOSEN', 'INSTRUCTOR_ASSIGNED');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('MEMBER', 'LEADER');

-- CreateEnum
CREATE TYPE "RepoStatus" AS ENUM ('QUEUED', 'PROVISIONING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AutogradeStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "githubId" BIGINT,
    "githubLogin" TEXT,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "avatarUrl" TEXT,
    "isSiteAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "isOwnerToken" BOOLEAN NOT NULL DEFAULT false,
    "tokenValidatedAt" TIMESTAMP(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "classrooms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseCode" TEXT,
    "term" TEXT,
    "slug" TEXT NOT NULL,
    "githubOrgLogin" TEXT NOT NULL,
    "githubOrgId" BIGINT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "ownerTokenUserId" TEXT,
    "defaultRepoVisibility" "RepoVisibility" NOT NULL DEFAULT 'PRIVATE',
    "defaultStudentPermission" "StudentPermission" NOT NULL DEFAULT 'PUSH',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classrooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_members" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ClassroomRole" NOT NULL DEFAULT 'STUDENT',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_links" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_entries" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "sisUserId" TEXT,
    "sisLoginId" TEXT,
    "email" TEXT,
    "section" TEXT,
    "rawColumns" JSONB NOT NULL,
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "AssignmentType" NOT NULL DEFAULT 'INDIVIDUAL',
    "templateOwner" TEXT NOT NULL,
    "templateRepo" TEXT NOT NULL,
    "repoPrefix" TEXT NOT NULL,
    "visibility" "RepoVisibility" NOT NULL DEFAULT 'PRIVATE',
    "studentPermission" "StudentPermission" NOT NULL DEFAULT 'PUSH',
    "deadline" TIMESTAMP(3),
    "lockOnDeadline" BOOLEAN NOT NULL DEFAULT false,
    "feedbackPrEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autogradeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxTeams" INTEGER,
    "maxTeamSize" INTEGER,
    "teamNamingMode" "TeamNamingMode" NOT NULL DEFAULT 'STUDENT_CHOSEN',
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_tests" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "setupCommand" TEXT,
    "runCommand" TEXT NOT NULL,
    "timeoutMinutes" INTEGER NOT NULL DEFAULT 10,
    "points" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "grading_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "githubTeamId" BIGINT,
    "githubTeamSlug" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "githubMembershipState" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_repos" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "githubRepoId" BIGINT,
    "fullName" TEXT,
    "htmlUrl" TEXT,
    "status" "RepoStatus" NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "invitationId" BIGINT,
    "feedbackPrNumber" INTEGER,
    "deadlineSha" TEXT,
    "manualScore" INTEGER,
    "manualScoreNote" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extensions" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "newDeadline" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autograde_runs" (
    "id" TEXT NOT NULL,
    "assignmentRepoId" TEXT NOT NULL,
    "workflowRunId" BIGINT NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" "AutogradeStatus" NOT NULL DEFAULT 'PENDING',
    "score" INTEGER,
    "maxScore" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rawResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autograde_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autograde_test_results" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "gradingTestId" TEXT,
    "name" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "maxPoints" INTEGER NOT NULL DEFAULT 0,
    "output" TEXT,

    CONSTRAINT "autograde_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_rate_budgets" (
    "installationId" BIGINT NOT NULL,
    "minuteTokens" DOUBLE PRECISION NOT NULL,
    "hourTokens" DOUBLE PRECISION NOT NULL,
    "minuteRefillAt" TIMESTAMP(3) NOT NULL,
    "hourRefillAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_rate_budgets_pkey" PRIMARY KEY ("installationId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "classroomId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_githubId_key" ON "users"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "users_githubLogin_key" ON "users"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_slug_key" ON "classrooms"("slug");

-- CreateIndex
CREATE INDEX "classrooms_githubOrgLogin_idx" ON "classrooms"("githubOrgLogin");

-- CreateIndex
CREATE INDEX "classroom_members_userId_idx" ON "classroom_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_members_classroomId_userId_key" ON "classroom_members"("classroomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "invite_links_token_key" ON "invite_links"("token");

-- CreateIndex
CREATE INDEX "invite_links_classroomId_idx" ON "invite_links"("classroomId");

-- CreateIndex
CREATE UNIQUE INDEX "roster_entries_claimedByUserId_key" ON "roster_entries"("claimedByUserId");

-- CreateIndex
CREATE INDEX "roster_entries_classroomId_idx" ON "roster_entries"("classroomId");

-- CreateIndex
CREATE UNIQUE INDEX "roster_entries_classroomId_sisUserId_key" ON "roster_entries"("classroomId", "sisUserId");

-- CreateIndex
CREATE INDEX "assignments_classroomId_idx" ON "assignments"("classroomId");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_classroomId_slug_key" ON "assignments"("classroomId", "slug");

-- CreateIndex
CREATE INDEX "grading_tests_assignmentId_idx" ON "grading_tests"("assignmentId");

-- CreateIndex
CREATE INDEX "teams_assignmentId_idx" ON "teams"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_assignmentId_name_key" ON "teams"("assignmentId", "name");

-- CreateIndex
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_teamId_userId_key" ON "team_members"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_repos_teamId_key" ON "assignment_repos"("teamId");

-- CreateIndex
CREATE INDEX "assignment_repos_assignmentId_idx" ON "assignment_repos"("assignmentId");

-- CreateIndex
CREATE INDEX "assignment_repos_status_idx" ON "assignment_repos"("status");

-- CreateIndex
CREATE INDEX "assignment_repos_githubRepoId_idx" ON "assignment_repos"("githubRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_repos_assignmentId_userId_key" ON "assignment_repos"("assignmentId", "userId");

-- CreateIndex
CREATE INDEX "extensions_assignmentId_idx" ON "extensions"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "extensions_assignmentId_userId_key" ON "extensions"("assignmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "extensions_assignmentId_teamId_key" ON "extensions"("assignmentId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "autograde_runs_workflowRunId_key" ON "autograde_runs"("workflowRunId");

-- CreateIndex
CREATE INDEX "autograde_runs_assignmentRepoId_idx" ON "autograde_runs"("assignmentRepoId");

-- CreateIndex
CREATE INDEX "autograde_test_results_runId_idx" ON "autograde_test_results"("runId");

-- CreateIndex
CREATE INDEX "audit_logs_classroomId_createdAt_idx" ON "audit_logs"("classroomId", "createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_ownerTokenUserId_fkey" FOREIGN KEY ("ownerTokenUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_members" ADD CONSTRAINT "classroom_members_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_members" ADD CONSTRAINT "classroom_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_links" ADD CONSTRAINT "invite_links_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_tests" ADD CONSTRAINT "grading_tests_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_repos" ADD CONSTRAINT "assignment_repos_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_repos" ADD CONSTRAINT "assignment_repos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_repos" ADD CONSTRAINT "assignment_repos_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extensions" ADD CONSTRAINT "extensions_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autograde_runs" ADD CONSTRAINT "autograde_runs_assignmentRepoId_fkey" FOREIGN KEY ("assignmentRepoId") REFERENCES "assignment_repos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autograde_test_results" ADD CONSTRAINT "autograde_test_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "autograde_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autograde_test_results" ADD CONSTRAINT "autograde_test_results_gradingTestId_fkey" FOREIGN KEY ("gradingTestId") REFERENCES "grading_tests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
