import assert from "node:assert/strict";
import test from "node:test";
import { UnsupportedImageMediaTypeError } from "@/server/chat/attachments/validation";
import {
  buildChatCompletionInput,
  UnsupportedStoredChatAttachmentError,
} from "@/server/chat/openai/responses/input";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
import type { ContentPart } from "@/server/chat/types";

const HEIC_BASE64_PREFIX = "AAAAGGZ0eXBoZWljAAAAAA==";
const JPEG_BASE64_PREFIX = "/9j/4AAQSkZJRg==";

test("buildChatCompletionInput rejects a legacy HEIC attachment without mutating history", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "file",
      fileName: "IMG_7071.HEIC",
      mediaType: "image/heic",
      base64Data: HEIC_BASE64_PREFIX,
    }],
  }];
  const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: "Continue" }];
  const originalMessages = structuredClone(localMessages);
  const originalTurnInput = structuredClone(turnInput);

  await assert.rejects(
    buildChatCompletionInput(localMessages, turnInput, "Europe/Madrid"),
    (error: unknown): boolean => {
      assert.ok(error instanceof UnsupportedStoredChatAttachmentError);
      assert.equal(error.fileName, "IMG_7071.HEIC");
      assert.equal(error.mediaType, "image/heic");
      assert.match(error.message, /filename "IMG_7071\.HEIC"/);
      assert.match(error.message, /media type "image\/heic"/);
      assert.equal(error.message.includes(HEIC_BASE64_PREFIX), false);
      return true;
    },
  );

  assert.deepEqual(localMessages, originalMessages);
  assert.deepEqual(turnInput, originalTurnInput);
});

test("buildChatCompletionInput replays a prepared JPEG as a native input image", async (): Promise<void> => {
  const localMessages: ReadonlyArray<ServerChatMessage> = [{
    role: "user",
    content: [{
      type: "image",
      mediaType: "image/jpeg",
      base64Data: JPEG_BASE64_PREFIX,
    }],
  }];

  const input = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "What is in the image?" }],
    "Europe/Madrid",
  );

  assert.deepEqual(input[1], {
    role: "user",
    type: "message",
    content: [{
      type: "input_image",
      detail: "auto",
      image_url: `data:image/jpeg;base64,${JPEG_BASE64_PREFIX}`,
    }],
  });
});

test("buildChatCompletionInput keeps current-turn attachment validation distinct", async (): Promise<void> => {
  await assert.rejects(
    buildChatCompletionInput(
      [],
      [{
        type: "image",
        mediaType: "image/heic",
        base64Data: HEIC_BASE64_PREFIX,
      }],
      "Europe/Madrid",
    ),
    UnsupportedImageMediaTypeError,
  );
});
