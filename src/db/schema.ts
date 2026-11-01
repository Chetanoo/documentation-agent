export const schemaSql = (dims: number) => `
create extension if not exists vector;

create table if not exists chunks (
  id              text primary key,          -- "/docs/...#n"
  path            text not null,             -- page path, used for recall@k
  url             text not null,             -- page URL + #anchor, used for citations
  title           text not null,
  section         text[] not null,
  crumb           text not null,             -- "Title > Section > Subsection"
  kind            text not null,             -- guide | reference | cookbook | migration-guide | troubleshooting
  content         text not null,
  tokens          int not null,
  hash            text not null,             -- sha256(model + chunk); unchanged hash = skip re-embedding
  embedding_model text not null,
  embedding       vector(${dims}) not null,
  tsv tsvector generated always as (
    setweight(to_tsvector('english', crumb), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) stored
);

create index if not exists chunks_embedding_hnsw on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_tsv_gin on chunks using gin (tsv);
create index if not exists chunks_path_idx on chunks (path);
`;
