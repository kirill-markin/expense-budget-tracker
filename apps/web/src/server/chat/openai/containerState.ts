import OpenAI from "openai";

import { queryAs } from "@/server/db";
import { log } from "@/server/logger";

type RetrieveContainerResult = Awaited<ReturnType<OpenAI["containers"]["retrieve"]>>;
type CreateContainerResult = Awaited<ReturnType<OpenAI["containers"]["create"]>>;

type ContainerStore = Readonly<{
  loadStoredContainer: (userId: string, workspaceId: string) => Promise<string | null>;
  saveStoredContainer: (userId: string, workspaceId: string, containerId: string) => Promise<void>;
  clearStoredContainer: (userId: string, workspaceId: string) => Promise<void>;
}>;

type OpenAIContainerClient = Readonly<{
  create: (body: Parameters<OpenAI["containers"]["create"]>[0]) => Promise<CreateContainerResult>;
  retrieve: (containerId: string) => Promise<RetrieveContainerResult>;
  delete: (containerId: string) => Promise<void>;
}>;

type ResolveContainerDependencies = Readonly<{
  containers: OpenAIContainerClient;
  store: ContainerStore;
}>;

type ResolveServerManagedContainerParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  createContainerName: (requestId: string) => string;
  isContainerExpired: (container: RetrieveContainerResult) => boolean;
  previousContainerId?: string | null;
}>;

type ResetServerManagedContainerDependencies = Readonly<{
  containers: OpenAIContainerClient;
  store: Pick<ContainerStore, "loadStoredContainer" | "clearStoredContainer">;
}>;

type ResetServerManagedContainerParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
}>;

const LOAD_STORED_CONTAINER_SQL = `
  SELECT container_id
  FROM public.chat_code_interpreter_containers
  WHERE user_id = $1
    AND workspace_id = $2
`;

const SAVE_STORED_CONTAINER_SQL = `
  INSERT INTO public.chat_code_interpreter_containers (
    user_id,
    workspace_id,
    container_id,
    updated_at
  ) VALUES ($1, $2, $3, now())
  ON CONFLICT (user_id, workspace_id)
  DO UPDATE
    SET container_id = EXCLUDED.container_id,
        updated_at = now()
`;

const CLEAR_STORED_CONTAINER_SQL = `
  DELETE FROM public.chat_code_interpreter_containers
  WHERE user_id = $1
    AND workspace_id = $2
`;

export const loadStoredContainer = async (
  userId: string,
  workspaceId: string,
): Promise<string | null> => {
  const result = await queryAs(userId, workspaceId, LOAD_STORED_CONTAINER_SQL, [userId, workspaceId]);
  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { container_id: string };
  return row.container_id;
};

export const saveStoredContainer = async (
  userId: string,
  workspaceId: string,
  containerId: string,
): Promise<void> => {
  await queryAs(userId, workspaceId, SAVE_STORED_CONTAINER_SQL, [userId, workspaceId, containerId]);
};

export const clearStoredContainer = async (
  userId: string,
  workspaceId: string,
): Promise<void> => {
  await queryAs(userId, workspaceId, CLEAR_STORED_CONTAINER_SQL, [userId, workspaceId]);
};

const getErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

const createAndStoreContainer = async (
  dependencies: ResolveContainerDependencies,
  params: ResolveServerManagedContainerParams,
): Promise<string> => {
  const containerName = params.createContainerName(params.requestId);
  const container = await dependencies.containers.create({
    name: containerName,
    expires_after: {
      anchor: "last_active_at",
      minutes: 20,
    },
  });

  await dependencies.store.saveStoredContainer(params.userId, params.workspaceId, container.id);

  log({
    domain: "chat",
    action: params.previousContainerId === undefined
      ? "code_interpreter_container_created"
      : "code_interpreter_container_recreated",
    vendor: "openai",
    requestId: params.requestId,
    codeInterpreterContainerId: params.previousContainerId ?? null,
    effectiveContainerId: container.id,
    containerName,
  });

  return container.id;
};

export const resolveServerManagedContainerWithDeps = async (
  dependencies: ResolveContainerDependencies,
  params: ResolveServerManagedContainerParams,
): Promise<string> => {
  const storedContainerId = await dependencies.store.loadStoredContainer(params.userId, params.workspaceId);
  if (storedContainerId === null) {
    return createAndStoreContainer(dependencies, params);
  }

  try {
    const container = await dependencies.containers.retrieve(storedContainerId);
    if (container.status !== "active" || params.isContainerExpired(container)) {
      log({
        domain: "chat",
        action: "code_interpreter_container_expired",
        vendor: "openai",
        requestId: params.requestId,
        codeInterpreterContainerId: storedContainerId,
        effectiveContainerId: storedContainerId,
        containerName: container.name,
        reason: container.status,
      });
      return createAndStoreContainer(dependencies, { ...params, previousContainerId: storedContainerId });
    }

    log({
      domain: "chat",
      action: "code_interpreter_container_reused",
      vendor: "openai",
      requestId: params.requestId,
      codeInterpreterContainerId: storedContainerId,
      effectiveContainerId: storedContainerId,
      containerName: container.name,
    });
    return storedContainerId;
  } catch (error) {
    const status = getErrorStatus(error);
    log({
      domain: "chat",
      action: status === 404
        ? "code_interpreter_container_not_found"
        : "code_interpreter_container_retrieve_failed",
      vendor: "openai",
      requestId: params.requestId,
      codeInterpreterContainerId: storedContainerId,
      effectiveContainerId: storedContainerId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return createAndStoreContainer(dependencies, { ...params, previousContainerId: storedContainerId });
  }
};

export const resolveServerManagedContainer = async (
  client: OpenAI,
  requestId: string,
  userId: string,
  workspaceId: string,
  createContainerName: (requestId: string) => string,
  isContainerExpired: (container: RetrieveContainerResult) => boolean,
): Promise<string> =>
  resolveServerManagedContainerWithDeps(
    {
      containers: client.containers,
      store: {
        loadStoredContainer,
        saveStoredContainer,
        clearStoredContainer,
      },
    },
    {
      requestId,
      userId,
      workspaceId,
      createContainerName,
      isContainerExpired,
    },
  );

export const resetServerManagedContainerWithDeps = async (
  dependencies: ResetServerManagedContainerDependencies,
  params: ResetServerManagedContainerParams,
): Promise<void> => {
  const storedContainerId = await dependencies.store.loadStoredContainer(params.userId, params.workspaceId);
  await dependencies.store.clearStoredContainer(params.userId, params.workspaceId);

  if (storedContainerId === null) {
    return;
  }

  try {
    await dependencies.containers.delete(storedContainerId);
    log({
      domain: "chat",
      action: "code_interpreter_container_deleted",
      vendor: "openai",
      requestId: params.requestId,
      codeInterpreterContainerId: storedContainerId,
      effectiveContainerId: storedContainerId,
    });
  } catch (error) {
    log({
      domain: "chat",
      action: "code_interpreter_container_delete_failed",
      vendor: "openai",
      requestId: params.requestId,
      codeInterpreterContainerId: storedContainerId,
      effectiveContainerId: storedContainerId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};

export const resetServerManagedContainer = async (
  client: OpenAI,
  requestId: string,
  userId: string,
  workspaceId: string,
): Promise<void> =>
  resetServerManagedContainerWithDeps(
    {
      containers: client.containers,
      store: {
        loadStoredContainer,
        clearStoredContainer,
      },
    },
    {
      requestId,
      userId,
      workspaceId,
    },
  );
