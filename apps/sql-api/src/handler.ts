import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { createMachineApiHandler } from "./machineApi.js";

const machineApiHandler = createMachineApiHandler({});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => machineApiHandler(event);
