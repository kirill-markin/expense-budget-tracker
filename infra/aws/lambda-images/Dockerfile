ARG AWS_NODE_BASE
FROM ${AWS_NODE_BASE} AS build
WORKDIR /workspace
RUN npm install --global npm@12.2.1
COPY . .
RUN npm ci && npm --workspace @expense-budget-tracker/agent-shared run build
ARG FUNCTION
RUN node infra/aws/lambda-images/build.mjs ${FUNCTION}

FROM ${AWS_NODE_BASE}
ARG FUNCTION
ENV LAMBDA_IMAGE_FUNCTION=${FUNCTION}
COPY --from=build /output/ ${LAMBDA_TASK_ROOT}/
RUN chmod -R a-w ${LAMBDA_TASK_ROOT} && chmod -R a+rX ${LAMBDA_TASK_ROOT}
CMD ["index.handler"]
