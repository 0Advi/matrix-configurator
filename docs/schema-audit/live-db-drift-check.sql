-- live-db-drift-check.sql — READ-ONLY introspection for the REAL Matrix-bd database.
--
-- Run it yourself (F2 never connects to your database):
--     psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f live-db-drift-check.sql > drift-report.txt
-- Use the SAME role the backend uses (DATABASE_URL) so D9 reports the app's real RLS posture.
-- Everything runs inside a READ ONLY transaction that is rolled back: no DDL, no DML, no locks
-- beyond ordinary catalog reads. Nothing here prints secrets or row contents beyond counts and
-- vocabularies (module keys, statuses).
--
-- What each section confirms (cross-reference docs/schema-audit/REPORT.md §2 "drift"):
--   D1 migration ledger vs origin/main 3d4f277 (missing / extra / checksum-changed files)
--   D2 column-level drift between schema.sql, verified.sql and the migrations
--   D3 every CHECK constraint in public (with NOT VALID flag) — the vocabularies the DB enforces
--   D4 the five module-key constraints this audit proposes to replace
--   D5 RLS flags + every policy
--   D6 functions/views the migrations reference but no repo file defines
--   D7 objects whose presence is disputed between the repo artefacts
--   D8 indexes from 202606133 (CREATE INDEX CONCURRENTLY cannot run inside the runner's txn)
--   D9 the connecting role (BYPASSRLS?) — i.e. does RLS apply to the app at all
--   D10 data facts that the proposed backfill depends on (counts only)
--   D11 name collisions with the proposed objects (all must be empty before rollout)

\pset pager off
\pset footer off
BEGIN TRANSACTION READ ONLY;

\echo '== D1 migration ledger vs origin/main (63 files) =='
WITH expected(filename, checksum) AS (VALUES
    ('202605221_add_workspace_requests.sql', '9851c48a01ff1264eb24e14328e6c379ea91ebb2ac75a856230b29154436b462'),
    ('202605241_role_canonicalization_and_lifecycle.sql', '19a1adfecad86c674df7d047015bcba4e8762b8787a485ba7a0795e2202fc515'),
    ('202605261_role_three_tier_business_admin.sql', '250c5f61ad4ba7f2a6451a8373afe9f841736fb570826f92e84216411c3162b9'),
    ('202605262_business_admins_table.sql', '15c368c08935412667a08a77ea4c92a21de12606ca2301b65162899997984524'),
    ('202605263_module_codes_table.sql', '7ef64034d12a6098e9ea8646c68da4c1b1bbfe619394e0246a69883c88e855f6'),
    ('202605264_supervisor_invite_codes_table.sql', 'd115faf4ef46c28c300f8a4334315994008340d0482f441f4c94e44fa9c4f961'),
    ('202605265_user_module_memberships_table.sql', '63db1db2b2b2d4efe7c139af127a2a52ab1c6ba5bfaa4c0923e426ba46da173f'),
    ('202605266_shortlist_delegations_executive_check.sql', '5050c9f9c173582d61577d0c58bb62cbeabcfa78f842ea628322ca81b2a34216'),
    ('202605267_users_notes_column.sql', '9e1931c42a5bb905c8824fbace419564ba668e9314ed0e4d2548300cab6bd042'),
    ('202605268_legal_workflow_tables.sql', 'a4fbf1ad6001b51f33fd90671440d33ce803f18f4aa4ffa6768b4ae75c129a2c'),
    ('202605269_legal_change_requests_table.sql', '63ec55ead73980ab0d91568e8bea7a788441d9f2824d8e6bc5f9366157a2fe83'),
    ('202605271_site_delegations.sql', '6c0dc6b673f1bfb035d36eabfcea66ea2589c61bd7ec9a13cd4aa8c64f5a79ca'),
    ('202605272_checklist_stage.sql', '3161848f5fe0627ba07dbf6d3c6638d450b8d1f19f759d60fd89648cf3e14f4e'),
    ('202606020_pipeline_rent_fields.sql', '4b83ab7c360c742762421ec606ce76c9dc3d1b60560db317f80861024cd5db58'),
    ('202606033_project_execution_foundation.sql', '3bb6cfe254121843e4a2d1385af27b1c0c143f42d6d62db5d1c3663a123e0c37'),
    ('202606081_passwords_branding_reset.sql', 'a6d552ce0675aefaaa11594d627d090216eafc87847e808412d52f6a31f1d42a'),
    ('202606091_project_budget_11_heads_area_covers.sql', 'd87c354a444e853c234372c20623ad273176c8068582bd10189a273e4c055f19'),
    ('202606092_project_execution_flow.sql', '31419c18bac5d8be36be4b86897183db54c5b3cee2f5c5a9c93a4d46f47d3131'),
    ('202606093_drop_stale_budget_idx_10_constraint.sql', 'adc8d0eb2f1fe97770a7b5a83df94bc69346f06332bb5396c63584d87769af17'),
    ('202606094_launch_approvals.sql', '4ba53818ecec47089e60e0ac925f7046b29365723ebd9e4b9d049b52d482ebbf'),
    ('20260609_nso_module.sql', 'c4d81fd52127b46c6e4fa205645039def707f1104044c4df45e5a15b68146548'),
    ('202606121_launch_validation_loop.sql', '8a0993f160380b9ef7a6cdaf4c554625cfc5682177323d10f70949b180f76c0b'),
    ('202606122_security_posture_lockdown.sql', '9f77f4ce21a7f7883bec5905087b15b945c10adada7b74d2dba4c7bb68862915'),
    ('202606123_reset_token_binding.sql', '2c8d478ea638dc20c3edab3a5d932db1c75e0e9c839439736ef39c90fbf48ed2'),
    ('202606131_drop_duplicate_approvals_indexes.sql', '7b6a3c060828d404d3f27b6a442b928ff66f1ce126cbeaf4d3a2ed200f335796'),
    ('202606131_drop_project_executions.sql', 'd5a09666e3cf82a426e09aa35af05b0d1e3693c3a58e3443db8af621a8034dec'),
    ('202606132_drop_duplicate_indexes_sweep.sql', 'f224e39c6418fe79e99db2ef2b63ffecf62360265e02aae06196286a6f1e4738'),
    ('202606132_retire_payment_module.sql', '25df043c4ab3eb4e9bbceefc2e5257d3cd225e784cb52c73f8a149fa30bc16b3'),
    ('202606133_fk_index_sweep.sql', '68960e59952149797df18acddafa7c81b73f14888214058f45757add652d2316'),
    ('202606134_project_excellence_module.sql', '76b46b7cb1e89d6bf699419d9a564001204a9a83ace3723539a8dfa79580f4cc'),
    ('202606140_drop_redundant_approvals_indexes.sql', '9928bd243a1b241837b223527a79d2549d053fc807902079d13de5eedb9d8d72'),
    ('202606141_drop_legacy_enum_types.sql', '8528ca14aec36cab126eade734278031f2e536d27b0a9bcad547c4e78bbb0cd2'),
    ('202606142_widen_module_checks_project_excellence.sql', '142b0c8f9146590248b5ab5ebf3f3837a583deb2776467b434601fb54a192f19'),
    ('202606144_shared_site_budgets.sql', '6de7dabaff9e1f6ebcbe0996337405568fe82bd8b7adaaaf25b1b28435b63054'),
    ('202606145_drop_legacy_project_budget.sql', 'bbe6a2434d00fef88ca2d40514e571687be8841e7b64834187e95cfe92f426a6'),
    ('202606146_nso_handover_pushed_at.sql', '2cb376bb00ac20db3cc4917bad3a45e697051c55ad89290faf82dd17ec5a7c2a'),
    ('202606147_financial_closure_delegation.sql', 'c4af0683893750663b19c83d27bd8ff6768d1cb97e15a8e307b041344ef07384'),
    ('202606231_supervisor_executive_requests.sql', 'b3ecf9e5bc5d81fe6e25da4b439d23f13cb49373ea61ef9c014595215f71e115'),
    ('202607081_add_sqft_and_staggered_rent.sql', '318fc7de0ad4402317bd460c9181189bf3e59b740cbda916c645c34297866b53'),
    ('20260713_add_na_to_legal_checklists.sql', '291a049ce7d93b34fe326f61d1639fecf549eacd6f0cfc8734299e85bc57d43f'),
    ('20260715_add_staggered_rent_type_and_sqft.sql', '318fc7de0ad4402317bd460c9181189bf3e59b740cbda916c645c34297866b53'),
    ('20260730_extend_rent_type_constraint.sql', '2db9f09ebca28a98eaf9f17c8af06ce6639e838ff7a1866d94ca5bd21ece84de'),
    ('20260731_fix_staggered_escalation_json_null.sql', '55d7f8d1e8545285d44aa77c040ddb49ffc0a25a0f144f2d5cd5cb9b54d1a625'),
    ('20260801_widen_area_sqft_to_numeric.sql', 'eb1b13b685f0ad99928c39b07af40fbfc62c21f4ad9e42494fce1138f14c32f2'),
    ('20260802_complete_rls_defense_in_depth.sql', '4b006e331da56779e6c0aae132ca010a6d93413852eec83b24457511260a7db4'),
    ('20260803_notification_outbox_drain_index.sql', 'c57159d0429a0c0ca09c9e63469cce58d575af9096cda7ed8f4e02f14e08d7c9'),
    ('20260803_rls_site_budgets.sql', 'b886fcaf88d87cde3f735b4d5872a0b02760ecc28596e06f13b00c00551d0331'),
    ('20260804_quality_audit_reports.sql', '4d92d0b03321135e850034bb84b051c6e76a9c9f1eae34385c4b2dc4c4c76b24'),
    ('20260805_qa_module_site_delegation.sql', 'db0f5b3ca200bf0f1fbedcd2717021f383de704327f9f67ed12bfb953be9a884'),
    ('20260806_site_files_excellence_type.sql', '6e8d45e0a31425c6f957b438833d542042f36bd85afc97a17fa4b3af8b3ff323'),
    ('20260807_loi_send_back_note.sql', '8df757783d0d763adb5a0e1557b5b459a5e8e8d73b6efec3510c3188170f439d'),
    ('20260808_site_files_closure_type.sql', 'c3dfa17cbacedc2fc8bd5791e8aed521fe0d69cc48372bbe5e449fa4ff881f94'),
    ('20260809_add_revshare_split_and_extend_staggered.sql', '33911807201bfdcdff129b1f4acc2a81fddcea48dbeec22a1600f27ee0f07a50'),
    ('20260810_launch_approvals_revshare_split.sql', 'a1996124de9a4e47cf48eec605003760192169327aa5317270507b0b640ec2ed'),
    ('20260811_launch_approvals_staggered_schedule.sql', 'fbb5d884ad81a33a347e61ff0a17c9db188502cc75450516b3d367fe3cea95b4'),
    ('20260812_reversible_actions.sql', '8467f7a8e6673c39717ab8f4e96e696ba1ae9d72a0ee0ecb54c75e9536925cab'),
    ('20260813_unique_ca_code_per_tenant.sql', 'a1d7e8e1d02f19188e59132c206f2ef7ebbd62aeb6c87d474fc17c484e7d349b'),
    ('20260814_site_delete_cascades.sql', '065691ad5d610ea0cb67f02446cca0eea9a993d8403d3d0480fbcd91ae85f79e'),
    ('20260815_drop_dead_bd_columns.sql', 'a2d914fceaf653a65ea782e001ce3fbd66bcc9cd1332c964fa326f274404f708'),
    ('20260816_add_observer_role.sql', 'f7e8116589a69f5ead4120caf7e8c2f9d51ea81c3786eef62c0fb351a14d1576'),
    ('20260817_observer_codes.sql', '5b71c1cec1b8604729cafe5f63c5b58537a976497f6c1675dca1667505226039'),
    ('20260818_multi_supervisor_executives.sql', 'bc355a3f4d96c54823a76f2ec41c6e3375624ae78df44d71d5e022a1de643261'),
    ('20260819_launch_rent_start_date.sql', 'f717bab9e6d8081c2a5b072f7f2e4936850959cba4cb85af8b07abcaf3a29f93')
), ledger AS (
    SELECT filename, checksum FROM public.schema_migrations
)
SELECT coalesce(e.filename, l.filename) AS filename,
       CASE WHEN l.filename IS NULL THEN 'MISSING from ledger (never applied, or failing every boot)'
            WHEN e.filename IS NULL THEN 'EXTRA in ledger (not in origin/main)'
            WHEN e.checksum <> l.checksum THEN 'CHECKSUM differs (file edited after apply / baseline of other content)'
            ELSE 'ok' END AS status
  FROM expected e FULL JOIN ledger l USING (filename)
 WHERE l.filename IS NULL OR e.filename IS NULL OR e.checksum <> l.checksum
 ORDER BY 1;
SELECT count(*) AS ledger_rows, min(applied_at) AS first_applied, max(applied_at) AS last_applied
  FROM public.schema_migrations;

\echo '== D2 column drift (expected per migrations; schema.sql/verified.sql differ where noted) =='
WITH probe(tbl, col, expectation, note) AS (VALUES
    ('sites','area_sqft','numeric','20260801 widened integer->numeric(12,2); schema.sql says integer'),
    ('sites','address','absent','20260815 dropped; schema.sql still lists it'),
    ('sites','notes','absent','20260815 dropped; schema.sql still lists it'),
    ('sites','spoc_email','absent','20260815 dropped; schema.sql still lists it'),
    ('sites','spoc_phone','absent','20260815 dropped; schema.sql still lists it'),
    ('site_files','onedrive_item_id','absent','20260815 dropped; schema.sql still lists it'),
    ('site_files','onedrive_synced_at','absent','20260815 dropped; schema.sql still lists it'),
    ('sites','project_excellence_status','present','202606134; ORM maps it; MISSING from schema.sql'),
    ('sites','financial_closure_status','present','202606144; ORM maps it; MISSING from schema.sql'),
    ('sites','expected_escalation_years','any','verified.sql: smallint; schema.sql: integer'),
    ('project_reviews','qa_reports_viewed_by_project_at','present','20260804; ORM maps it; MISSING from schema.sql'),
    ('password_reset_requests','reset_token_hash','present','202606123; MISSING from schema.sql'),
    ('password_reset_requests','token_expires_at','present','202606123; MISSING from schema.sql'),
    ('site_details','completion_pct','any','out-of-band generated column (verified.sql); not in schema.sql/migrations'),
    ('notification_outbox','tenant_id','any','verified.sql: nullable; schema.sql: NOT NULL'),
    ('workspace_requests','status','any','verified.sql: enum workspace_request_status; schema.sql: text+CHECK'),
    ('user_module_memberships','has_executive_access','present','202606231'),
    ('launch_approvals','rent_start_date','present','20260819 (latest migration)')
)
SELECT p.tbl, p.col, p.expectation,
       CASE WHEN c.column_name IS NULL THEN 'absent'
            ELSE c.data_type || CASE WHEN c.data_type='numeric' THEN '(' || coalesce(c.numeric_precision::text,'') || ',' || coalesce(c.numeric_scale::text,'') || ')' ELSE '' END
                 || ' null=' || c.is_nullable || CASE WHEN c.is_generated='ALWAYS' THEN ' GENERATED' ELSE '' END
                 || CASE WHEN c.data_type='USER-DEFINED' THEN ' udt=' || c.udt_name ELSE '' END END AS actual,
       p.note
  FROM probe p
  LEFT JOIN information_schema.columns c
    ON c.table_schema='public' AND c.table_name=p.tbl AND c.column_name=p.col
 ORDER BY 1,2;

\echo '== D3 every CHECK constraint in public (NOT VALID ones are invisible in verified.sql) =='
SELECT rel.relname AS table_name, con.conname,
       CASE WHEN con.convalidated THEN '' ELSE 'NOT VALID' END AS validated,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
 WHERE ns.nspname = 'public' AND con.contype = 'c'
 ORDER BY 1, 2;

\echo '== D4 the module-key constraints (expected: one IN-list CHECK per table; site_delegations incl. quality_audit; three incl. payment) =='
SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition, con.convalidated
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
 WHERE rel.relnamespace = 'public'::regnamespace
   AND rel.relname IN ('module_codes','supervisor_invite_codes','user_module_memberships',
                       'site_delegations','supervisor_executive_requests')
   AND att.attname = 'module'
 ORDER BY 1, 2;
SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition, con.convalidated
  FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
 WHERE rel.relnamespace = 'public'::regnamespace AND rel.relname = 'sites'
   AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%status%'
 ORDER BY 2;

\echo '== D5 RLS flags and policies =='
SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
 ORDER BY 1;
SELECT tablename, policyname, cmd, roles, qual, with_check
  FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2;

\echo '== D6 functions / views referenced by migrations but defined out-of-band =='
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS security_definer,
       md5(pg_get_functiondef(p.oid)) AS body_md5
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('current_tenant_id','get_current_tenant_id','handle_new_auth_user',
                     'is_valid_staggered_escalation')
 ORDER BY 1;
SELECT table_name AS view_name FROM information_schema.views WHERE table_schema='public' ORDER BY 1;
SELECT c.relname AS view_name, c.reloptions
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='v' ORDER BY 1;
SELECT t.typname AS enum_type, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
 WHERE t.typnamespace = 'public'::regnamespace GROUP BY 1 ORDER BY 1;

\echo '== D7 disputed objects (present?) =='
SELECT name, to_regclass('public.' || name) IS NOT NULL AS present, note
  FROM (VALUES
    ('project_excellence_reviews','202606134 creates; 202606144 says "never applied"; 20260802 says it exists on live'),
    ('project_excellence_items','202606134'),
    ('project_budget_items','202606134/202606145 drop it'),
    ('project_executions','202606131 drops it'),
    ('quality_audit_reports','20260804; MISSING from schema.sql + verified.sql'),
    ('observer_codes','20260817'),
    ('reversible_actions','20260812'),
    ('supervisor_executive_requests','202606231'),
    ('schema_migrations','created by the ledger runner (d1e99c6, 2026-07-11)')
  ) v(name, note)
 ORDER BY 1;

\echo '== D8 indexes from 202606133 (CREATE INDEX CONCURRENTLY: fails inside the runner txn) =='
SELECT n AS index_name, to_regclass('public.' || n) IS NOT NULL AS present
  FROM unnest(ARRAY['idx_design_deliverables_tenant_id','idx_launch_review_events_tenant_id',
                    'idx_project_budget_items_tenant_id','idx_supervisor_invite_codes_tenant_id',
                    'idx_workspace_requests_provisioned_tenant_id','idx_notification_outbox_site_id']) AS n
 ORDER BY 1;

\echo '== D9 the connecting role: does RLS apply to the backend at all? =='
SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
       current_setting('request.jwt.claims', true) AS jwt_claims_guc
  FROM pg_roles r WHERE r.rolname = current_user;

\echo '== D10 data facts the proposed backfill depends on (counts / vocabularies only) =='
SELECT count(*) AS tenants FROM public.tenants;
SELECT 'module_codes' AS t, module, count(*) FROM public.module_codes GROUP BY 1,2
UNION ALL SELECT 'supervisor_invite_codes', module, count(*) FROM public.supervisor_invite_codes GROUP BY 1,2
UNION ALL SELECT 'user_module_memberships', module, count(*) FROM public.user_module_memberships GROUP BY 1,2
UNION ALL SELECT 'site_delegations', module, count(*) FROM public.site_delegations GROUP BY 1,2
UNION ALL SELECT 'supervisor_executive_requests', module, count(*) FROM public.supervisor_executive_requests GROUP BY 1,2
 ORDER BY 1, 2;
SELECT status, count(*) FROM public.sites GROUP BY 1 ORDER BY 1;
SELECT finance_status, design_status, project_excellence_status, financial_closure_status, count(*)
  FROM public.sites GROUP BY 1,2,3,4 ORDER BY 5 DESC LIMIT 25;

\echo '== D11 proposed object names must not exist yet =='
SELECT n AS proposed_object, to_regclass('public.' || n) AS existing
  FROM unnest(ARRAY['tenant_config_releases','tenant_config_live','module_catalog','tenant_modules',
                    'module_records','module_stage_states','module_approvals','site_module_outcomes']) AS n;
SELECT column_name AS proposed_column_already_present, table_name
  FROM information_schema.columns
 WHERE table_schema='public'
   AND ((table_name='sites' AND column_name='config_release_id')
     OR (table_name='audit_logs' AND column_name IN ('config_release_id','module_key','provenance')));

ROLLBACK;
