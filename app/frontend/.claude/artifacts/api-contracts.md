# API Contracts

Generated: 2026-05-21. These 11 endpoints are implemented by both `mockAdapter.js` and `httpAdapter.js`.

---

## 1. GET /sites

List sites with optional filters.

**Query params**
- `status` — one or more SiteStatus values (UPPER_SNAKE_CASE)
- `created_by` — user id or name
- `city` — city string

**Response** `Site[]`

---

## 2. GET /sites/:id

Fetch a single site by id.

**Params** `id: string`

**Response** `Site`

---

## 3. POST /sites

Create a new site draft.

**Body**
```json
{
  "name": "string",
  "city": "string",
  "visitDate": "YYYY-MM-DD",
  "createdBy": { "id": "string", "name": "string" },
  "tenantId": "string"
}
```

**Response** `Site`

---

## 4. PATCH /sites/:id/status

Transition a site to a new status (enforces valid transitions via state machine).

**Params** `id: string`

**Body**
```json
{
  "status": "SiteStatus (UPPER_SNAKE_CASE)",
  "payload": {
    "by": "string (optional)",
    "note": "string (optional)",
    "expectedLoiDays": "number (optional)",
    "rejectionReasons": "string[] (optional)",
    "archiveNote": "string (optional)",
    "details": "object (optional)",
    "spocName": "string (optional)"
  }
}
```

**Response** `Site`

**Throws** `400` if the transition is invalid per `ALLOWED_TRANSITIONS`.

---

## 5. POST /sites/:id/loi

Upload a signed LOI file for a site. Transitions site to `LOI_UPLOADED`.

**Params** `id: string`

**Body** `multipart/form-data` with field `file: File`

**Response**
```json
{ "url": "string", "uploadedAt": "YYYY-MM-DD" }
```

---

## 6. POST /sites/:id/archive

Archive a site. Transitions to `ARCHIVED`.

**Params** `id: string`

**Body** `{ "note": "string" }`

**Response** `Site`

---

## 7. POST /sites/:id/reject

Reject a site. Transitions to `REJECTED`.

**Params** `id: string`

**Body** `{ "reasons": "string[]", "comment": "string" }`

**Response** `Site`

---

## 8. POST /sites/:id/assign

Assign a site to a BD exec.

**Params** `id: string`

**Body** `{ "exec_id": "string" }`

**Response** `Site`

---

## 9. GET /users/me

Return the currently authenticated user's session.

**Response**
```json
{
  "id": "string",
  "name": "string",
  "email": "string",
  "role": "executive | supervisor | sub_supervisor",
  "cityScope": "string",
  "tenantId": "string",
  "token": "string"
}
```

---

## 10. POST /auth/login

Authenticate and return a session.

**Body** `{ "email": "string", "password": "string" }`

**Response** Session (same shape as `/users/me`)

---

## 11. POST /auth/logout

Invalidate the current session.

**Body** (empty)

**Response** `{ "ok": true }`

---

## Site Shape

```typescript
{
  id: string;
  code: string;                   // e.g. "BT-MUM-0144"
  name: string;
  city: string;
  tenantId: string;
  status: SiteStatus;             // UPPER_SNAKE_CASE
  createdBy: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  visitDate: string;              // YYYY-MM-DD
  expectedLoiDays: number | null;
  loiUrl: string | null;
  details: object | null;
  rejectionReasons: string[] | null;
  archiveNote: string | null;
  createdAt: string;              // ISO-8601
  updatedAt: string;              // ISO-8601
  auditTrail: AuditEntry[];
  // Shortlist UI fields
  score: number | string;
  estSales: number | string;
  carpet: number | string;
  rent: number | string;
  rentType: string;
  totalOpCost: number;
  hue: number;
}
```

## SiteStatus values

```
DRAFT_SUBMITTED
SHORTLISTED
DETAILS_SUBMITTED
APPROVED
LOI_UPLOADED
PUSHED_TO_PAYMENTS
REJECTED
ARCHIVED
```
