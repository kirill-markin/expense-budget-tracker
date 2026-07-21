import {
  emptySqlSourceRange,
  throwSqlPolicyParserError,
} from "./sql-policy-parser-model.js";
import type {
  SqlCallNode,
  SqlExpressionMetadata,
  SqlNestedQueryNode,
  SqlTypeConstructNode,
} from "./sql-policy-read-model.js";

type SqlExpressionMetadataSequenceCounts = Readonly<{
  callCount: number;
  nestedQueryCount: number;
  typeConstructCount: number;
}>;

type SqlExpressionMetadataEmptySequence =
  SqlExpressionMetadataSequenceCounts & Readonly<{
    kind: "empty";
  }>;

type SqlExpressionMetadataCallSequence =
  SqlExpressionMetadataSequenceCounts & Readonly<{
    kind: "call";
    node: SqlCallNode;
  }>;

type SqlExpressionMetadataNestedQuerySequence =
  SqlExpressionMetadataSequenceCounts & Readonly<{
    kind: "nested_query";
    node: SqlNestedQueryNode;
  }>;

type SqlExpressionMetadataTypeConstructSequence =
  SqlExpressionMetadataSequenceCounts & Readonly<{
    kind: "type_construct";
    node: SqlTypeConstructNode;
  }>;

type SqlExpressionMetadataConcatSequence =
  SqlExpressionMetadataSequenceCounts & Readonly<{
    kind: "concat";
    left: SqlExpressionMetadataSequence;
    right: SqlExpressionMetadataSequence;
  }>;

export type SqlExpressionMetadataSequence =
  | SqlExpressionMetadataEmptySequence
  | SqlExpressionMetadataCallSequence
  | SqlExpressionMetadataNestedQuerySequence
  | SqlExpressionMetadataTypeConstructSequence
  | SqlExpressionMetadataConcatSequence;

const MAX_ARRAY_LENGTH = 4_294_967_295;

const EMPTY_SQL_EXPRESSION_METADATA_SEQUENCE:
  SqlExpressionMetadataEmptySequence = Object.freeze({
    callCount: 0,
    kind: "empty",
    nestedQueryCount: 0,
    typeConstructCount: 0,
  });

const sqlExpressionMetadataInvariant = (message: string): never =>
  throwSqlPolicyParserError(
    "internal_invariant",
    message,
    emptySqlSourceRange(0),
  );

const validateSequenceObject = (
  sequence: SqlExpressionMetadataSequence,
  subject: string,
): void => {
  if (
    typeof sequence !== "object"
    || sequence === null
    || Array.isArray(sequence)
  ) {
    return sqlExpressionMetadataInvariant(
      `${subject} must be a non-null, non-array object`,
    );
  }
};

const validateMetadataNode = (
  node: SqlCallNode | SqlNestedQueryNode | SqlTypeConstructNode,
  subject: string,
): void => {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return sqlExpressionMetadataInvariant(
      `${subject} must be a non-null, non-array object`,
    );
  }
};

const validateMetadataCount = (
  value: number,
  subject: string,
): void => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return sqlExpressionMetadataInvariant(
      `${subject} must be a non-negative safe integer; received ${String(value)}`,
    );
  }
};

const validateSequenceCounts = (
  sequence: SqlExpressionMetadataSequence,
  subject: string,
): void => {
  validateSequenceObject(sequence, subject);
  validateMetadataCount(sequence.callCount, `${subject} call count`);
  validateMetadataCount(
    sequence.nestedQueryCount,
    `${subject} nested-query count`,
  );
  validateMetadataCount(
    sequence.typeConstructCount,
    `${subject} type-construct count`,
  );
};

const checkedMetadataCountSum = (
  first: number,
  second: number,
  subject: string,
): number => {
  const sum = first + second;
  if (!Number.isSafeInteger(sum)) {
    return sqlExpressionMetadataInvariant(
      `${subject} overflow while adding ${String(first)} and ${String(second)}`,
    );
  }
  return sum;
};

const assertExpectedCount = (
  actual: number,
  expected: number,
  subject: string,
): void => {
  if (actual !== expected) {
    return sqlExpressionMetadataInvariant(
      `${subject} is ${String(actual)} but must be ${String(expected)}`,
    );
  }
};

const assertSequenceCounts = (
  sequence: SqlExpressionMetadataSequence,
  expectedCalls: number,
  expectedNestedQueries: number,
  expectedTypeConstructs: number,
  subject: string,
): void => {
  assertExpectedCount(
    sequence.callCount,
    expectedCalls,
    `${subject} call count`,
  );
  assertExpectedCount(
    sequence.nestedQueryCount,
    expectedNestedQueries,
    `${subject} nested-query count`,
  );
  assertExpectedCount(
    sequence.typeConstructCount,
    expectedTypeConstructs,
    `${subject} type-construct count`,
  );
};

const unsupportedMetadataSequence = (
  sequence: never,
  subject: string,
): never => {
  void sequence;
  return sqlExpressionMetadataInvariant(
    `${subject} has an unsupported sequence discriminant`,
  );
};

const validateSequenceRoot = (
  sequence: SqlExpressionMetadataSequence,
  subject: string,
): void => {
  validateSequenceCounts(sequence, subject);
  if (sequence.kind === "empty") {
    assertSequenceCounts(sequence, 0, 0, 0, subject);
    return;
  }
  if (sequence.kind === "call") {
    assertSequenceCounts(sequence, 1, 0, 0, subject);
    validateMetadataNode(sequence.node, `${subject} call node`);
    return;
  }
  if (sequence.kind === "nested_query") {
    assertSequenceCounts(sequence, 0, 1, 0, subject);
    validateMetadataNode(sequence.node, `${subject} nested-query node`);
    return;
  }
  if (sequence.kind === "type_construct") {
    assertSequenceCounts(sequence, 0, 0, 1, subject);
    validateMetadataNode(sequence.node, `${subject} type-construct node`);
    return;
  }
  if (sequence.kind === "concat") {
    validateSequenceCounts(sequence.left, `${subject} left child`);
    validateSequenceCounts(sequence.right, `${subject} right child`);
    assertSequenceCounts(
      sequence,
      checkedMetadataCountSum(
        sequence.left.callCount,
        sequence.right.callCount,
        `${subject} call count`,
      ),
      checkedMetadataCountSum(
        sequence.left.nestedQueryCount,
        sequence.right.nestedQueryCount,
        `${subject} nested-query count`,
      ),
      checkedMetadataCountSum(
        sequence.left.typeConstructCount,
        sequence.right.typeConstructCount,
        `${subject} type-construct count`,
      ),
      subject,
    );
    return;
  }
  return unsupportedMetadataSequence(sequence, subject);
};

const validateMaterializableCount = (
  count: number,
  subject: string,
): void => {
  if (count > MAX_ARRAY_LENGTH) {
    return sqlExpressionMetadataInvariant(
      `${subject} ${String(count)} exceeds maximum array length ${String(MAX_ARRAY_LENGTH)}`,
    );
  }
};

/** Returns the canonical empty persistent metadata sequence in O(1). */
export const emptySqlExpressionMetadataSequence = ():
  SqlExpressionMetadataSequence => EMPTY_SQL_EXPRESSION_METADATA_SEQUENCE;

/** Creates one persistent call-metadata leaf in O(1). */
export const sqlCallMetadataSequence = (
  node: SqlCallNode,
): SqlExpressionMetadataSequence => {
  validateMetadataNode(node, "SQL expression metadata call node");
  return Object.freeze({
    callCount: 1,
    kind: "call",
    nestedQueryCount: 0,
    node,
    typeConstructCount: 0,
  });
};

/** Creates one persistent nested-query-metadata leaf in O(1). */
export const sqlNestedQueryMetadataSequence = (
  node: SqlNestedQueryNode,
): SqlExpressionMetadataSequence => {
  validateMetadataNode(node, "SQL expression metadata nested-query node");
  return Object.freeze({
    callCount: 0,
    kind: "nested_query",
    nestedQueryCount: 1,
    node,
    typeConstructCount: 0,
  });
};

/** Creates one persistent type-construct-metadata leaf in O(1). */
export const sqlTypeConstructMetadataSequence = (
  node: SqlTypeConstructNode,
): SqlExpressionMetadataSequence => {
  validateMetadataNode(node, "SQL expression metadata type-construct node");
  return Object.freeze({
    callCount: 0,
    kind: "type_construct",
    nestedQueryCount: 0,
    node,
    typeConstructCount: 1,
  });
};

/** Joins two persistent metadata sequences without walking either input. */
export const concatSqlExpressionMetadataSequences = (
  left: SqlExpressionMetadataSequence,
  right: SqlExpressionMetadataSequence,
): SqlExpressionMetadataSequence => {
  validateSequenceRoot(left, "Left SQL expression metadata sequence");
  validateSequenceRoot(right, "Right SQL expression metadata sequence");
  if (left.kind === "empty") {
    return right;
  }
  if (right.kind === "empty") {
    return left;
  }
  return Object.freeze({
    callCount: checkedMetadataCountSum(
      left.callCount,
      right.callCount,
      "SQL expression metadata call count",
    ),
    kind: "concat",
    left,
    nestedQueryCount: checkedMetadataCountSum(
      left.nestedQueryCount,
      right.nestedQueryCount,
      "SQL expression metadata nested-query count",
    ),
    right,
    typeConstructCount: checkedMetadataCountSum(
      left.typeConstructCount,
      right.typeConstructCount,
      "SQL expression metadata type-construct count",
    ),
  });
};

/** Materializes a persistent sequence once in iterative O(n) time. */
export const materializeSqlExpressionMetadataSequence = (
  sequence: SqlExpressionMetadataSequence,
): SqlExpressionMetadata => {
  validateSequenceRoot(sequence, "SQL expression metadata sequence");
  validateMaterializableCount(
    sequence.callCount,
    "SQL expression metadata call count",
  );
  validateMaterializableCount(
    sequence.nestedQueryCount,
    "SQL expression metadata nested-query count",
  );
  validateMaterializableCount(
    sequence.typeConstructCount,
    "SQL expression metadata type-construct count",
  );

  const calls = new Array<SqlCallNode>(sequence.callCount);
  const nestedQueries = new Array<SqlNestedQueryNode>(
    sequence.nestedQueryCount,
  );
  const typeConstructs = new Array<SqlTypeConstructNode>(
    sequence.typeConstructCount,
  );
  const stack: Array<SqlExpressionMetadataSequence> = [sequence];
  let callIndex = 0;
  let nestedQueryIndex = 0;
  let typeConstructIndex = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      return sqlExpressionMetadataInvariant(
        "SQL expression metadata traversal stack lost its final sequence",
      );
    }
    validateSequenceRoot(current, "SQL expression metadata sequence node");
    if (current.kind === "empty") {
      continue;
    }
    if (current.kind === "concat") {
      stack.push(current.right, current.left);
      continue;
    }
    if (current.kind === "call") {
      if (callIndex >= calls.length) {
        return sqlExpressionMetadataInvariant(
          "SQL expression metadata traversal exceeded its advertised call count",
        );
      }
      calls[callIndex] = current.node;
      callIndex++;
      continue;
    }
    if (current.kind === "nested_query") {
      if (nestedQueryIndex >= nestedQueries.length) {
        return sqlExpressionMetadataInvariant(
          "SQL expression metadata traversal exceeded its advertised nested-query count",
        );
      }
      nestedQueries[nestedQueryIndex] = current.node;
      nestedQueryIndex++;
      continue;
    }
    if (current.kind === "type_construct") {
      if (typeConstructIndex >= typeConstructs.length) {
        return sqlExpressionMetadataInvariant(
          "SQL expression metadata traversal exceeded its advertised type-construct count",
        );
      }
      typeConstructs[typeConstructIndex] = current.node;
      typeConstructIndex++;
      continue;
    }
    return unsupportedMetadataSequence(
      current,
      "SQL expression metadata sequence node",
    );
  }

  assertExpectedCount(
    callIndex,
    calls.length,
    "Materialized SQL expression metadata call count",
  );
  assertExpectedCount(
    nestedQueryIndex,
    nestedQueries.length,
    "Materialized SQL expression metadata nested-query count",
  );
  assertExpectedCount(
    typeConstructIndex,
    typeConstructs.length,
    "Materialized SQL expression metadata type-construct count",
  );
  return Object.freeze({
    calls: Object.freeze(calls),
    nestedQueries: Object.freeze(nestedQueries),
    typeConstructs: Object.freeze(typeConstructs),
  });
};
