import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { createMachineApiHandler } from "./machineApi";

const machineApiHandler = createMachineApiHandler();

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => machineApiHandler(event);
