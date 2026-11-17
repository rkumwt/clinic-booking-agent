# AI Appointment Booking Agent

Patients talk to an AI agent (chat, then voice) to find a doctor, book, reschedule,
cancel and pay for a clinic appointment. Admins and doctors manage schedules and
bookings from a dashboard. Slot allocation is automatic.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Monorepo, docker-compose, Prisma schema, migration, seed, JWT auth | Done |
| 2 | Slots, hold, confirm, cancel, reschedule, jobs, event bus, tests | Done |
| 3 | LangGraph agent, tools, FAQ RAG, memory, chat endpoint | Next |
| 4 | Patient chat app, admin/doctor dashboard | Planned |
| 5 | Razorpay test payments, webhooks, email | Planned |
| 6 | Browser voice mode with barge-in | Planned |
| 7 | Langfuse tracing, cost tracking, agent evals | Planned |
| 8 | AWS CDK deploy, GitHub Actions CI | Planned |

## Architecture

Solid boxes exist today; dashed boxes arrive in later phases.

```mermaid
flowchart LR
  subgraph Clients
    PA[Patient app<br/>chat + voice]:::planned
    DB[Dashboard<br/>admin + doctor]:::planned
  end

  subgraph API[apps/api - NestJS]
    AUTH[Auth<br/>JWT + roles]
    DOC[Doctors<br/>hours + leaves]
    SLOT[Slots<br/>generate / hold / expire]
    BOOK[Bookings<br/>confirm / cancel / reschedule]
    BUS((Event bus))
    AGENT[Agent<br/>LangGraph]:::planned
    PAY[Payments<br/>Razorpay]:::planned
    WS[Realtime gateway]:::planned
  end

  PG[(PostgreSQL 16<br/>+ pgvector)]
  RD[(Redis)]
  LLM[Bedrock / OpenAI / Ollama]:::planned

  PA --> AGENT
  DB --> AUTH
  DB --> DOC
  AGENT --> BOOK
  AGENT --> LLM
  DOC --> SLOT
  BOOK --> SLOT
  SLOT --> RD
  SLOT --> PG
  BOOK --> PG
  BOOK --> BUS
  SLOT --> BUS
  PAY --> BUS
  BUS --> WS
  WS --> DB

  classDef planned stroke-dasharray: 5 5
```

## Repository layout

```
apps/api            NestJS API: auth, doctors, slots, bookings, events
  prisma/           schema, migrations, seed
  test/             Supertest e2e tests
packages/shared     zod schemas and types shared by API, agent and frontends
docker-compose.yml  postgres (pgvector) + redis
```

`apps/patient-app`, `apps/dashboard`, `packages/agent`, `packages/llm`, `evals/`
and `infra/cdk` are added in their phases.

## Setup

Requirements: Node 22+, pnpm 9, Docker.

```bash
cp .env.example .env        # then set JWT_SECRET and the two SEED_*_PASSWORD values
pnpm install
pnpm infra:up               # postgres on :5440, redis on :6380
pnpm --filter @clinic/api db:deploy   # apply migrations
pnpm db:seed                # 1 admin, 5 doctors, 2 weeks of slots, 10 FAQs
pnpm dev                    # API on http://localhost:4000
```

Postgres and Redis use host ports 5440 and 6380 so they do not clash with other
local databases. Change them in `docker-compose.yml` and `.env` together.

### Tests

```bash
pnpm test        # unit tests
pnpm test:e2e    # Supertest e2e against a separate clinic_test database
```

The e2e suite creates and migrates `clinic_test` on its own and uses Redis
database 1, so it never touches dev data.

### Trying it by hand

Seeded logins are `SEED_ADMIN_EMAIL` and the doctor emails in
`apps/api/prisma/seed.ts` (for example `rohan.mehta@clinic.test`), with the
passwords from your `.env`.

```bash
# log in as admin
curl -s -X POST localhost:4000/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@clinic.test","password":"<SEED_ADMIN_PASSWORD>"}'

# anonymous patient token, as the chat app will use
curl -s -X POST localhost:4000/auth/guest

# find a doctor and their free slots
curl -s 'localhost:4000/doctors?specialization=cardio'
curl -s 'localhost:4000/doctors/<doctorId>/slots?date=2026-11-18'

# hold, then confirm (TOKEN = any accessToken from above)
curl -s -X POST localhost:4000/slots/<slotId>/hold -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"holderKey":"my-chat-session-1"}'
curl -s -X POST localhost:4000/bookings -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "slotId":"<slotId>","holderKey":"my-chat-session-1","idempotencyKey":"booking-attempt-1",
    "patient":{"name":"Asha Verma","phone":"9876543210"}}'

# cancel as the patient (phone proves ownership) or as admin (no phone needed)
curl -s -X POST localhost:4000/bookings/<bookingId>/cancel -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"phone":"9876543210","reason":"Changed plans"}'
```

## API (phases 1-2)

| Method | Path | Access |
|---|---|---|
| POST | `/auth/login`, `/auth/guest` | public |
| GET | `/auth/me` | any token |
| GET | `/users` | ADMIN |
| GET | `/doctors`, `/doctors/:id`, `/doctors/:id/slots?date=` | public |
| POST / PATCH | `/doctors`, `/doctors/:id` | ADMIN |
| PUT | `/doctors/:id/working-hours` | ADMIN, own DOCTOR |
| GET / POST / DELETE | `/doctors/:id/leaves` | ADMIN, own DOCTOR |
| GET | `/doctors/:id/slots/all?from=&to=` | ADMIN, DOCTOR |
| POST / DELETE | `/slots/:id/hold` | any token |
| POST | `/slots/generate` | ADMIN |
| POST | `/bookings` | any token |
| GET | `/bookings`, `/bookings/:id` | ADMIN, DOCTOR (own only) |
| POST | `/bookings/:id/cancel`, `/bookings/:id/reschedule` | ADMIN, own DOCTOR, PATIENT with matching phone |

## Interview notes

### Double-booking prevention

Three layers, each cheaper and less trustworthy than the next.

1. **Redis `SET NX EX`** on `hold:slot:<id>`. When two people tap the same slot
   the loser is rejected in one round trip without touching Postgres. This is a
   fast path only. If Redis is down the code logs a warning and carries on.
2. **Conditional `UPDATE` in Postgres.** Holding runs
   `UPDATE slots SET status='HELD' ... WHERE id=? AND (status='FREE' OR hold expired OR held by me)`.
   The check and the write are one atomic statement, so of N concurrent
   requests exactly one changes a row. Confirming does the same from `HELD` to
   `BOOKED`, checking the caller still owns a live hold.
3. **Partial unique index** `bookings(slot_id) WHERE status <> 'CANCELLED'`.
   Even a buggy code path that skips the service cannot insert a second active
   booking. It is partial so a slot can be rebooked after a cancellation.

The e2e suite proves each layer: 20 concurrent holds give one winner, the same
with Redis mocked as unavailable, and a raw insert that bypasses the service is
rejected by the database.

### Idempotency

- `holdSlot` is keyed by `holderKey` (the chat session). Holding again with the
  same key refreshes the hold instead of failing.
- `confirmBooking` takes an `idempotencyKey` with a unique index. A retry
  returns the first booking. Five identical requests sent at once produce one
  booking and five identical responses: the losers of the race look the
  winner up by key rather than surfacing a conflict.
- `cancel` on a cancelled booking and `reschedule` to the current slot are no-ops.
- Slot generation relies on `UNIQUE(doctor_id, start_time)` and
  `skipDuplicates`, so the job can run any number of times.

This matters more with an LLM in the loop: models retry tool calls and
occasionally call the same tool twice.

### Slot lifecycle

`FREE → HELD → BOOKED`, with `HELD → FREE` when a hold expires (a job runs every
minute; availability queries also treat an expired hold as free, so nothing waits
on the job). Generation is a sync rather than an append: it computes the desired
slots from working hours minus leaves, adds what is missing and removes free
slots that no longer belong. Booked slots inside a new leave are never deleted;
they are reported as `conflicts` for an admin to resolve. A fourth status,
`BLOCKED`, parks a slot that is outside the schedule but still referenced by an
old booking.

### Time

Everything is stored in UTC. Working hours are wall-clock times in
`CLINIC_TIMEZONE` and converted per day, so the generator is correct across
daylight-saving changes (covered by a unit test).

### Auth

Guards depend on an `AuthProvider` interface with `login`, `issueGuestToken` and
`verifyToken`. `LocalJwtAuthProvider` implements it now; a Cognito provider can
replace it without touching guards or controllers. Patients chat as anonymous
guests and become a patient record (keyed by phone) when they book. To change a
booking over REST a patient must supply the phone it was made with, and a wrong
phone gets the same 404 as a missing booking.

### Events

Services publish typed domain events (`booking.created`, `slot.held`, ...) to an
`EventBus` interface. The in-memory implementation isolates subscriber failures,
so a broken email handler cannot fail a booking. Swapping in SQS or EventBridge
means writing one class.

### Decisions that differ from the obvious

- **No vector index.** With ten FAQ rows an exact scan is faster than HNSW, and
  Prisma Migrate would try to drop an index it cannot describe.
- **Money is never refunded automatically.** Cancelling a paid booking sets
  `REFUND_PENDING`; an admin approves it (phase 3 wires this to a LangGraph
  interrupt).
- **Pinned majors**: NestJS 11, Prisma 6, TypeScript 5, zod 3.

Agent graph, latency and cost notes are added with phases 3 and 7.
