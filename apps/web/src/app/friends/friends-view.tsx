'use client';

import type { Profile } from '@cb/contracts';
import { Alert, Badge, Button, Card, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@cb/ui';
import { Check, Inbox, Search, Send, UserMinus, Users, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { EmptyState, PeopleSkeleton, PersonRow } from '@/components/people';
import { isApiError, messageFor } from '@/lib/api';
import {
  useAcceptRequest,
  useCancelRequest,
  useFriendRequests,
  useFriends,
  useRejectRequest,
  useRemoveFriend,
  useSendFriendRequest,
  useUserSearch,
} from '@/lib/friends';
import { useRequireAuth } from '@/lib/session';

const TABS = ['friends', 'requests', 'find'] as const;
type Tab = (typeof TABS)[number];

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (s < 3600) return fmt.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86_400) return fmt.format(-Math.round(s / 3600), 'hour');
  return fmt.format(-Math.round(s / 86_400), 'day');
};

export function FriendsView() {
  useRequireAuth();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'friends';
  const incoming = useFriendRequests('incoming');
  const incomingCount = incoming.data?.pages.reduce((n, p) => n + p.items.length, 0) ?? 0;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Friends</h1>
        <p className="mt-1 text-muted-foreground">Battle your friends. Find new rivals by username.</p>
      </div>
      <Tabs value={tab} onValueChange={(t) => router.replace(`${pathname}?tab=${t}`, { scroll: false })}>
        <TabsList>
          <TabsTrigger value="friends">
            <Users className="size-4" aria-hidden /> Friends
          </TabsTrigger>
          <TabsTrigger value="requests">
            <Inbox className="size-4" aria-hidden /> Requests
            {incomingCount > 0 && <Badge className="ml-1 px-1.5">{incomingCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="find">
            <Search className="size-4" aria-hidden /> Find players
          </TabsTrigger>
        </TabsList>
        <TabsContent value="friends">
          <FriendsList onFind={() => router.replace(`${pathname}?tab=find`)} />
        </TabsContent>
        <TabsContent value="requests">
          <Requests />
        </TabsContent>
        <TabsContent value="find">
          <FindPlayers />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LoadMore({
  q,
}: {
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!q.hasNextPage) return null;
  return (
    <div className="pt-2 text-center">
      <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
        Load more
      </Button>
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  return <Alert variant="destructive">{messageFor(error)}</Alert>;
}

function FriendsList({ onFind }: { onFind: () => void }) {
  const friends = useFriends();
  const remove = useRemoveFriend();
  const items = friends.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card className="px-4">
      {friends.isPending ? (
        <PeopleSkeleton />
      ) : friends.isError ? (
        <div className="py-4">
          <ErrorNote error={friends.error} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Users />} title="No friends yet">
          <Button className="mt-2" size="sm" onClick={onFind}>
            <Search /> Find players
          </Button>
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {items.map((f) => (
              <PersonRow
                key={f.id}
                user={f}
                meta={`friends ${ago(f.since)}`}
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${f.username}`}
                    loading={remove.isPending && remove.variables === f.id}
                    onClick={() => remove.mutate(f.id)}
                  >
                    <UserMinus />
                    <span className="hidden sm:inline">Remove</span>
                  </Button>
                }
              />
            ))}
          </ul>
          <LoadMore q={friends} />
        </>
      )}
    </Card>
  );
}

function Requests() {
  const incoming = useFriendRequests('incoming');
  const outgoing = useFriendRequests('outgoing');
  const accept = useAcceptRequest();
  const reject = useRejectRequest();
  const cancel = useCancelRequest();
  const inItems = incoming.data?.pages.flatMap((p) => p.items) ?? [];
  const outItems = outgoing.data?.pages.flatMap((p) => p.items) ?? [];
  const busy = (m: { isPending: boolean; variables?: string | undefined }, id: string) =>
    m.isPending && m.variables === id;

  return (
    <div className="grid gap-6">
      <section aria-labelledby="incoming-h">
        <h2 id="incoming-h" className="mb-2 text-sm font-medium text-muted-foreground">
          Received
        </h2>
        <Card className="px-4">
          {incoming.isPending ? (
            <PeopleSkeleton rows={2} />
          ) : incoming.isError ? (
            <div className="py-4">
              <ErrorNote error={incoming.error} />
            </div>
          ) : inItems.length === 0 ? (
            <EmptyState icon={<Inbox />} title="No pending requests" />
          ) : (
            <>
              <ul className="divide-y divide-border">
                {inItems.map((r) => (
                  <PersonRow
                    key={r.user.id}
                    user={r.user}
                    meta={ago(r.createdAt)}
                    actions={
                      <>
                        <Button
                          size="sm"
                          loading={busy(accept, r.user.id)}
                          onClick={() => accept.mutate(r.user.id)}
                        >
                          <Check /> Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Decline ${r.user.username}`}
                          loading={busy(reject, r.user.id)}
                          onClick={() => reject.mutate(r.user.id)}
                        >
                          <X />
                          <span className="hidden sm:inline">Decline</span>
                        </Button>
                      </>
                    }
                  />
                ))}
              </ul>
              <LoadMore q={incoming} />
            </>
          )}
        </Card>
      </section>

      <section aria-labelledby="outgoing-h">
        <h2 id="outgoing-h" className="mb-2 text-sm font-medium text-muted-foreground">
          Sent
        </h2>
        <Card className="px-4">
          {outgoing.isPending ? (
            <PeopleSkeleton rows={1} />
          ) : outItems.length === 0 ? (
            <EmptyState icon={<Send />} title="No sent requests" />
          ) : (
            <>
              <ul className="divide-y divide-border">
                {outItems.map((r) => (
                  <PersonRow
                    key={r.user.id}
                    user={r.user}
                    meta={`sent ${ago(r.createdAt)}`}
                    actions={
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy(cancel, r.user.id)}
                        onClick={() => cancel.mutate(r.user.id)}
                      >
                        Cancel
                      </Button>
                    }
                  />
                ))}
              </ul>
              <LoadMore q={outgoing} />
            </>
          )}
        </Card>
      </section>
    </div>
  );
}

function FindPlayers() {
  const [input, setInput] = useState('');
  const q = useDeferredValue(input.trim());
  const search = useUserSearch(q);
  const items = search.data?.pages.flatMap((p) => p.items) ?? [];
  const fuzzy = search.data?.pages[0]?.fuzzy ?? false;

  return (
    <div className="grid gap-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          aria-label="Search players by username"
          placeholder="Search by username"
          className="pl-9"
          value={input}
          maxLength={20}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
      </div>
      <Card className="px-4">
        {!q ? (
          <EmptyState icon={<Search />} title="Find players">
            Type the start of a username.
          </EmptyState>
        ) : search.isPending ? (
          <PeopleSkeleton rows={2} />
        ) : search.isError ? (
          <div className="py-4">
            <ErrorNote error={search.error} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Search />} title={`No players match “${q}”`} />
        ) : (
          <>
            {fuzzy && <p className="pt-3 text-sm text-muted-foreground">No exact matches. Did you mean…</p>}
            <ul className="divide-y divide-border">
              {items.map((u) => (
                <PersonRow key={u.id} user={u} actions={<AddButton user={u} />} />
              ))}
            </ul>
            <LoadMore q={search} />
          </>
        )}
      </Card>
    </div>
  );
}

/** Search results don't carry the relationship, so the outcome is shown after clicking. */
function AddButton({ user }: { user: Profile }) {
  const send = useSendFriendRequest();
  const [note, setNote] = useState<string>();

  if (send.isSuccess) {
    return (
      <Badge variant={send.data.status === 'accepted' ? 'success' : 'secondary'}>
        {send.data.status === 'accepted' ? 'Friends' : 'Requested'}
      </Badge>
    );
  }
  return (
    <div className="grid justify-items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        loading={send.isPending}
        onClick={() =>
          send.mutate(user.id, {
            onError: (e) =>
              setNote(
                isApiError(e, 'ALREADY_FRIENDS')
                  ? 'Already friends'
                  : isApiError(e, 'FRIEND_REQUEST_EXISTS')
                    ? 'Already requested'
                    : isApiError(e, 'EMAIL_NOT_VERIFIED')
                      ? 'Verify your email first'
                      : messageFor(e),
              ),
          })
        }
      >
        Add
      </Button>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
