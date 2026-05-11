-- =============================================================================
-- 004_rbac.sql -- Three-role RBAC normalization.
--
-- Renames existing "member" role rows to "estimator" so the role enum is now
-- one of: admin | estimator | viewer. The auth signup default also moves to
-- "estimator" (handled in code, not the schema).
-- =============================================================================
UPDATE users SET role = 'estimator' WHERE role = 'member';
