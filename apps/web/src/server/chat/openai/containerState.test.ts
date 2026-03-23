import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import {
  resetServerManagedContainerWithDeps,
  resolveServerManagedContainerWithDeps,
} from "./containerState";

type RetrieveContainerResult = Awaited<ReturnType<OpenAI["containers"]["retrieve"]>>;
type CreateContainerResult = Awaited<ReturnType<OpenAI["containers"]["create"]>>;

type FakeStore = Readonly<{
  loadStoredContainer: (userId: string, workspaceId: string, sessionId: string) => Promise<string | null>;
  saveStoredContainer: (userId: string, workspaceId: string, sessionId: string, containerId: string) => Promise<void>;
  clearStoredContainer: (userId: string, workspaceId: string, sessionId: string) => Promise<void>;
  getStored: () => string | null;
  savedContainerIds: Array<string>;
}>;

const createRetrievedContainer = (
  id: string,
  name: string,
  status: string,
  createdAt: number,
  lastActiveAt: number,
): RetrieveContainerResult => ({
  id,
  created_at: createdAt,
  last_active_at: lastActiveAt,
  name,
  object: "container",
  status,
});

const createCreatedContainer = (id: string, name: string): CreateContainerResult => ({
  id,
  created_at: 1,
  name,
  object: "container",
  status: "active",
});

const createFakeStore = (initialContainerId: string | null): FakeStore => {
  let storedContainerId = initialContainerId;
  const savedContainerIds: Array<string> = [];

  return {
    loadStoredContainer: async (): Promise<string | null> => storedContainerId,
    saveStoredContainer: async (
      _userId: string,
      _workspaceId: string,
      _sessionId: string,
      containerId: string,
    ): Promise<void> => {
      storedContainerId = containerId;
      savedContainerIds.push(containerId);
    },
    clearStoredContainer: async (
      _userId: string,
      _workspaceId: string,
      _sessionId: string,
    ): Promise<void> => {
      storedContainerId = null;
    },
    getStored: (): string | null => storedContainerId,
    savedContainerIds,
  };
};

test("resolveServerManagedContainerWithDeps creates and stores a container when no record exists", async () => {
  const store = createFakeStore(null);
  let createCalls = 0;

  const containerId = await resolveServerManagedContainerWithDeps(
    {
      containers: {
        create: async (): Promise<CreateContainerResult> => {
          createCalls += 1;
          return createCreatedContainer("ctr-new", "expense-chat-request-1");
        },
        retrieve: async (): Promise<RetrieveContainerResult> => {
          throw new Error("retrieve should not be called");
        },
        delete: async (): Promise<void> => undefined,
      },
      store,
    },
    {
      requestId: "request-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      createContainerName: (requestId: string): string => `expense-chat-${requestId}`,
      isContainerExpired: (): boolean => false,
    },
  );

  assert.equal(containerId, "ctr-new");
  assert.equal(createCalls, 1);
  assert.equal(store.getStored(), "ctr-new");
  assert.deepEqual(store.savedContainerIds, ["ctr-new"]);
});

test("resolveServerManagedContainerWithDeps reuses an active stored container", async () => {
  const store = createFakeStore("ctr-existing");
  let createCalls = 0;
  let retrieveCalls = 0;

  const containerId = await resolveServerManagedContainerWithDeps(
    {
      containers: {
        create: async (): Promise<CreateContainerResult> => {
          createCalls += 1;
          return createCreatedContainer("ctr-new", "expense-chat-request-1");
        },
        retrieve: async (): Promise<RetrieveContainerResult> => {
          retrieveCalls += 1;
          return createRetrievedContainer("ctr-existing", "expense-chat-old", "active", 1, Math.floor(Date.now() / 1000));
        },
        delete: async (): Promise<void> => undefined,
      },
      store,
    },
    {
      requestId: "request-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      createContainerName: (requestId: string): string => `expense-chat-${requestId}`,
      isContainerExpired: (): boolean => false,
    },
  );

  assert.equal(containerId, "ctr-existing");
  assert.equal(retrieveCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(store.getStored(), "ctr-existing");
});

test("resolveServerManagedContainerWithDeps recreates when retrieve fails", async () => {
  const store = createFakeStore("ctr-stale");
  let createCalls = 0;

  const notFoundError = new Error("missing") as Error & { status?: number };
  notFoundError.status = 404;

  const containerId = await resolveServerManagedContainerWithDeps(
    {
      containers: {
        create: async (): Promise<CreateContainerResult> => {
          createCalls += 1;
          return createCreatedContainer("ctr-new", "expense-chat-request-2");
        },
        retrieve: async (): Promise<RetrieveContainerResult> => {
          throw notFoundError;
        },
        delete: async (): Promise<void> => undefined,
      },
      store,
    },
    {
      requestId: "request-2",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      createContainerName: (requestId: string): string => `expense-chat-${requestId}`,
      isContainerExpired: (): boolean => false,
    },
  );

  assert.equal(containerId, "ctr-new");
  assert.equal(createCalls, 1);
  assert.equal(store.getStored(), "ctr-new");
});

test("resolveServerManagedContainerWithDeps recreates expired containers", async () => {
  const store = createFakeStore("ctr-expired");
  let createCalls = 0;

  const containerId = await resolveServerManagedContainerWithDeps(
    {
      containers: {
        create: async (): Promise<CreateContainerResult> => {
          createCalls += 1;
          return createCreatedContainer("ctr-fresh", "expense-chat-request-3");
        },
        retrieve: async (): Promise<RetrieveContainerResult> =>
          createRetrievedContainer("ctr-expired", "expense-chat-old", "active", 1, 1),
        delete: async (): Promise<void> => undefined,
      },
      store,
    },
    {
      requestId: "request-3",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      createContainerName: (requestId: string): string => `expense-chat-${requestId}`,
      isContainerExpired: (): boolean => true,
    },
  );

  assert.equal(containerId, "ctr-fresh");
  assert.equal(createCalls, 1);
  assert.equal(store.getStored(), "ctr-fresh");
});

test("resetServerManagedContainerWithDeps clears the stored row even when OpenAI delete fails", async () => {
  const store = createFakeStore("ctr-existing");

  await resetServerManagedContainerWithDeps(
    {
      containers: {
        create: async (): Promise<CreateContainerResult> => {
          throw new Error("create should not be called");
        },
        retrieve: async (): Promise<RetrieveContainerResult> => {
          throw new Error("retrieve should not be called");
        },
        delete: async (): Promise<void> => {
          throw new Error("delete failed");
        },
      },
      store,
    },
    {
      requestId: "request-4",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    },
  );

  assert.equal(store.getStored(), null);
});
