import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  createOptimisticMutation,
  type OptimisticMutationContext,
} from './optimisticMutations';

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

interface TodoState {
  todos: Todo[];
}

const makeClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

const seed = (client: QueryClient, key: readonly unknown[], state: TodoState) => {
  client.setQueryData(key, state);
};

const read = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryData<TodoState>(key);

describe('createOptimisticMutation', () => {
  let client: QueryClient;
  const key = ['todos'] as const;

  beforeEach(() => {
    client = makeClient();
  });

  it('applies the optimistic update and keeps it on success', async () => {
    seed(client, key, { todos: [{ id: '1', title: 'a', done: false }] });

    const mutation = createOptimisticMutation<TodoState, { id: string }, void>({
      queryClient: client,
      queryKey: key,
      mutationFn: async () => undefined,
      optimisticUpdate: (state, vars) => ({
        todos: state.todos.map((t) =>
          t.id === vars.id ? { ...t, done: true } : t,
        ),
      }),
    });

    await mutation.mutateAsync({ id: '1' });

    expect(read(client, key)).toEqual({
      todos: [{ id: '1', title: 'a', done: true }],
    });
  });

  it('restores the exact prior state when the mutation fails', async () => {
    const prior: TodoState = {
      todos: [{ id: '1', title: 'a', done: false }],
    };
    seed(client, key, prior);

    const mutation = createOptimisticMutation<TodoState, { id: string }, void>({
      queryClient: client,
      queryKey: key,
      mutationFn: async () => {
        throw new Error('boom');
      },
      optimisticUpdate: (state, vars) => ({
        todos: state.todos.map((t) =>
          t.id === vars.id ? { ...t, done: true } : t,
        ),
      }),
    });

    await expect(mutation.mutateAsync({ id: '1' })).rejects.toThrow('boom');

    // Deep equality against the exact prior snapshot.
    expect(read(client, key)).toEqual(prior);
    // And it must be a distinct object, not the mutated reference.
    expect(read(client, key)).not.toBe(prior);
  });

  it('reports failures through the toast reporter', async () => {
    seed(client, key, { todos: [] });
    const onError = vi.fn();

    const mutation = createOptimisticMutation<TodoState, { id: string }, void>({
      queryClient: client,
      queryKey: key,
      mutationFn: async () => {
        throw new Error('nope');
      },
      optimisticUpdate: (state) => state,
      toast: { onError },
    });

    await expect(mutation.mutateAsync({ id: '1' })).rejects.toThrow('nope');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('resolves overlapping mutations deterministically (last write wins)', async () => {
    seed(client, key, { todos: [{ id: '1', title: 'a', done: false }] });

    const resolvers: Array<() => void> = [];
    const mutation = createOptimisticMutation<TodoState, { id: string }, void>({
      queryClient: client,
      queryKey: key,
      mutationFn: () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      optimisticUpdate: (state, vars) => ({
        todos: state.todos.map((t) =>
          t.id === vars.id ? { ...t, done: true } : t,
        ),
      }),
    });

    const first = mutation.mutateAsync({ id: '1' });
    const second = mutation.mutateAsync({ id: '1' });

    // Both optimistic updates applied; the second is the latest write.
    expect(read(client, key)).toEqual({
      todos: [{ id: '1', title: 'a', done: true }],
    });

    resolvers.forEach((resolve) => resolve());
    await Promise.all([first, second]);

    expect(read(client, key)).toEqual({
      todos: [{ id: '1', title: 'a', done: true }],
    });
  });

  it('does not roll back a newer mutation when an older one fails', async () => {
    seed(client, key, { todos: [{ id: '1', title: 'a', done: false }] });

    let rejectFirst: (err: Error) => void = () => undefined;
    let resolveSecond: () => void = () => undefined;
    let call = 0;

    const mutation = createOptimisticMutation<TodoState, { id: string }, void>({
      queryClient: client,
      queryKey: key,
      mutationFn: () => {
        call += 1;
        if (call === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return new Promise<void>((resolve) => {
          resolveSecond = resolve;
        });
      },
      optimisticUpdate: (state, vars) => ({
        todos: state.todos.map((t) =>
          t.id === vars.id ? { ...t, done: true } : t,
        ),
      }),
    });

    const first = mutation.mutateAsync({ id: '1' });
    const second = mutation.mutateAsync({ id: '1' });

    rejectFirst(new Error('stale failure'));
    await expect(first).rejects.toThrow('stale failure');

    // The newer optimistic write must survive the stale rollback.
    expect(read(client, key)).toEqual({
      todos: [{ id: '1', title: 'a', done: true }],
    });

    resolveSecond();
    await second;
  });

  it('exposes the snapshot and variables on the mutation context', async () => {
    const prior: TodoState = { todos: [{ id: '1', title: 'a', done: false }] };
    seed(client, key, prior);

    let captured: OptimisticMutationContext<TodoState, { id: string }> | undefined;

    const mutation = createOptimisticMutation<TodoState, { id: string }, void>({
      queryClient: client,
      queryKey: key,
      mutationFn: async () => undefined,
      optimisticUpdate: (state) => state,
      onMutate: (ctx) => {
        captured = ctx;
      },
    });

    await mutation.mutateAsync({ id: '1' });

    expect(captured?.snapshot).toEqual(prior);
    expect(captured?.variables).toEqual({ id: '1' });
  });
});
