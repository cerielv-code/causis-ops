# Migrations

Every schema change lives here first, named `<version>_<name>.sql` with the same version
as in `supabase_migrations.schema_migrations`. Claude applies them to project
stbxetfzbssalewbglpg through the Supabase connection right after committing.
Files are applied in name order and never edited after they are applied.
