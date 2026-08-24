-- Initial schema: the in-memory owner -> routes -> segments tree, made durable.
--
-- Points live in their own column (JSON text, not jsonb: nothing ever queries
-- inside them, they are read and written whole) so that listRoutes can read
-- route metadata without dragging multi-megabyte arrays off disk.

create table if not exists owners (
	id          text primary key,               -- the klym_sid cookie
	user_id     text,                           -- null until real accounts land (M13+)
	last_seen   timestamptz not null default now()
);

create table if not exists routes (
	owner_id       text not null references owners(id) on delete cascade,
	id             text not null,               -- slugified name, unique per owner
	name           text not null,
	-- Null for builtin-overlay rows: the RouteData comes from the shared
	-- read-only registry in builtin.ts and is never copied per visitor.
	points         text,                        -- JSON RoutePoint[]
	bounds         jsonb,
	total_dist_m   double precision,
	total_ascent_m double precision,
	point_count    integer,
	builtin        boolean not null default false,
	created_at     timestamptz not null,
	primary key (owner_id, id)
);

create table if not exists segments (
	owner_id     text not null,
	route_id     text not null,
	id           text not null,                 -- slugified name, unique per route
	name         text not null,
	start_dist_m double precision not null,
	end_dist_m   double precision not null,
	bin_size_m   double precision not null,
	created_at   timestamptz not null,
	primary key (owner_id, route_id, id),
	foreign key (owner_id, route_id) references routes(owner_id, id) on delete cascade
);

create index if not exists routes_owner_created_idx
	on routes (owner_id, created_at desc) where not builtin;
create index if not exists owners_last_seen_idx on owners (last_seen);
