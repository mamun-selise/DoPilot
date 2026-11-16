import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { blocksClient } from "../../lib/blocks/client";

// Where each PR sits on the Ready to stage board, kept in this project's Blocks Data (schema ReleaseBoardCard, see
// blocks/data/schemas) so moving cards changes nothing on GitHub. A PR with no card is in "Open PRs".
export type BoardColumn = "ready" | "merged" | "deployed";

export type BoardCard = {
  ItemId: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  column: BoardColumn;
  position: number;
  commit: string | null;
  movedBy: string | null;
  LastUpdatedDate?: string;
};

const FIELDS = ["repo", "number", "title", "url", "column", "position", "commit", "movedBy", "LastUpdatedDate"];
const cards = blocksClient.data.collection<BoardCard>("ReleaseBoardCard", { fields: FIELDS });

// Repos are stored lower-case, so a board is the same however the repository name is spelled.
const repoKey = (repo: string) => repo.toLowerCase();
const queryKey = (repo: string) => ["board-cards", repoKey(repo)];

async function listCards(repo: string): Promise<BoardCard[]> {
  const all: BoardCard[] = [];
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const page = unwrap(await cards.list({ pageNo, pageSize: 200, filter: { repo: repoKey(repo) } }));
    all.push(...page.items);
    if (!page.hasNextPage) break;
  }
  // Belt and braces: keep only this repository even if the gateway ignored the filter.
  return all.filter((card) => card.repo === repoKey(repo));
}

export function useBoardCards(repo: string) {
  return useQuery({ queryKey: queryKey(repo), queryFn: () => listCards(repo), staleTime: 15_000, refetchInterval: 30_000 });
}

type Change =
  | { kind: "add"; number: number; title: string; url: string; column: BoardColumn; position: number; movedBy: string | null }
  | { kind: "update"; card: BoardCard; patch: Partial<Pick<BoardCard, "column" | "position" | "commit" | "title" | "url" | "movedBy">> }
  | { kind: "remove"; card: BoardCard };

// One mutation for every board change; the card moves on screen at once and the list is re-read afterwards.
export function useBoardChange(repo: string) {
  const queryClient = useQueryClient();
  const key = queryKey(repo);
  return useMutation({
    mutationFn: async (change: Change) => {
      if (change.kind === "add") {
        const { kind: _kind, ...fields } = change;
        return check(await cards.create({ ...fields, repo: repoKey(repo), commit: null }));
      }
      if (change.kind === "update") return check(await cards.update(change.card.ItemId, change.patch));
      return check(await cards.delete(change.card.ItemId));
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<BoardCard[]>(key);
      if (before) {
        queryClient.setQueryData<BoardCard[]>(key, apply(before, change, repo));
      }
      return { before };
    },
    onError: (_error, _change, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key })
  });
}

function apply(list: BoardCard[], change: Change, repo: string): BoardCard[] {
  if (change.kind === "add") {
    const { kind: _kind, ...fields } = change;
    return [...list.filter((card) => card.number !== change.number), { ...fields, ItemId: `pending-${change.number}`, repo: repoKey(repo), commit: null }];
  }
  if (change.kind === "update") return list.map((card) => (card.ItemId === change.card.ItemId ? { ...card, ...change.patch } : card));
  return list.filter((card) => card.ItemId !== change.card.ItemId);
}

// The gateway answers { data: { getReleaseBoardCards: { items, hasNextPage } } }, or { errors } when it refuses.
function unwrap(response: unknown): { items: BoardCard[]; hasNextPage: boolean } {
  failOnErrors(response);
  const record = response as { data?: Record<string, { items?: BoardCard[]; hasNextPage?: boolean } | undefined> };
  const page = record.data?.getReleaseBoardCards ?? Object.values(record.data ?? {})[0];
  return { items: page?.items ?? [], hasNextPage: Boolean(page?.hasNextPage) };
}

// Mutations answer { data: { insertReleaseBoardCard: { acknowledged, message } } }.
function check(response: unknown) {
  failOnErrors(response);
  const result = Object.values((response as { data?: Record<string, { acknowledged?: boolean; message?: string } | null> }).data ?? {})[0];
  if (result && result.acknowledged === false) throw new Error(result.message || "Blocks Data did not save the board change.");
  return response;
}

function failOnErrors(response: unknown) {
  const errors = (response as { errors?: { message?: string }[] }).errors;
  if (errors?.length) {
    const message = errors.map((error) => error.message).filter(Boolean).join("; ");
    // The schema is created with `blocks data sync`; until then the gateway does not know the query.
    if (/ReleaseBoardCard/i.test(message) && /(does not exist|not found|unknown|cannot query)/i.test(message))
      throw new Error("The board's Blocks Data schema (ReleaseBoardCard) is not set up yet. Run blocks data sync in the DoPilot repo.");
    throw new Error(message || "Blocks Data refused the request.");
  }
}
