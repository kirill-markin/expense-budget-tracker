import assert from "node:assert/strict";
import test from "node:test";
import type { SqlSourceRange } from "./sql-policy-lexer.js";
import {
  concatSqlExpressionMetadataSequences,
  emptySqlExpressionMetadataSequence,
  materializeSqlExpressionMetadataSequence,
  sqlCallMetadataSequence,
  sqlNestedQueryMetadataSequence,
  sqlTypeConstructMetadataSequence,
  type SqlExpressionMetadataSequence,
} from "./sql-policy-read-metadata.js";
import type {
  SqlCallNode,
  SqlNestedQueryNode,
  SqlTypeConstructNode,
} from "./sql-policy-read-model.js";
import type { SqlTypeNameNode } from "./sql-policy-type-model.js";

type SqlMetadataLeafConstructor =
  | typeof sqlCallMetadataSequence
  | typeof sqlNestedQueryMetadataSequence
  | typeof sqlTypeConstructMetadataSequence;

const sourceRange = (index: number): SqlSourceRange => Object.freeze({
  end: index + 1,
  start: index,
});

const callNode = (queryId: number): SqlCallNode => {
  const range = sourceRange(queryId);
  return Object.freeze({
    argumentsRange: range,
    context: "root",
    path: Object.freeze([]),
    queryId,
    range,
    syntaxContext: "expression",
  });
};

const nestedQueryNode = (parentQueryId: number): SqlNestedQueryNode => {
  const range = sourceRange(parentQueryId);
  return Object.freeze({
    bodyRange: range,
    context: "nested",
    endIndex: parentQueryId + 1,
    kind: "expression",
    parentQueryId,
    range,
    startIndex: parentQueryId,
  });
};

const typeConstructNode = (queryId: number): SqlTypeConstructNode => {
  const range = sourceRange(queryId);
  const typeName: SqlTypeNameNode = Object.freeze({
    arrayBounds: Object.freeze([]),
    form: "integer",
    intervalQualifier: null,
    modifiers: Object.freeze([]),
    nameParts: Object.freeze([]),
    nameRange: range,
    range,
    setOf: false,
    sql: "integer",
    timeZone: null,
  });
  return Object.freeze({
    context: "root",
    queryId,
    range,
    syntax: "cast",
    typeName,
  });
};

const expectMetadataInvariant = (
  action: () => void,
  message: RegExp,
): void => {
  assert.throws(action, {
    code: "internal_invariant",
    message,
    range: { start: 0, end: 0 },
  });
};

const materializeMalformedSequence = (
  sequence: object | number | null,
): void => {
  Reflect.apply(materializeSqlExpressionMetadataSequence, null, [sequence]);
};

const createMalformedLeaf = (
  createSequence: SqlMetadataLeafConstructor,
  node: object | number | null,
): void => {
  Reflect.apply(createSequence, null, [node]);
};

test("empty and single-node sequences materialize every metadata kind", (): void => {
  const call = callNode(11);
  const nestedQuery = nestedQueryNode(12);
  const typeConstruct = typeConstructNode(13);
  const cases: ReadonlyArray<Readonly<{
    sequence: SqlExpressionMetadataSequence;
    expected: Readonly<{
      calls: ReadonlyArray<SqlCallNode>;
      nestedQueries: ReadonlyArray<SqlNestedQueryNode>;
      typeConstructs: ReadonlyArray<SqlTypeConstructNode>;
    }>;
  }>> = [
    {
      expected: { calls: [], nestedQueries: [], typeConstructs: [] },
      sequence: emptySqlExpressionMetadataSequence(),
    },
    {
      expected: { calls: [call], nestedQueries: [], typeConstructs: [] },
      sequence: sqlCallMetadataSequence(call),
    },
    {
      expected: {
        calls: [],
        nestedQueries: [nestedQuery],
        typeConstructs: [],
      },
      sequence: sqlNestedQueryMetadataSequence(nestedQuery),
    },
    {
      expected: {
        calls: [],
        nestedQueries: [],
        typeConstructs: [typeConstruct],
      },
      sequence: sqlTypeConstructMetadataSequence(typeConstruct),
    },
  ];

  for (const current of cases) {
    const materialized = materializeSqlExpressionMetadataSequence(
      current.sequence,
    );
    assert.deepEqual(materialized, current.expected);
    assert.ok(Object.isFrozen(current.sequence));
    assert.ok(Object.isFrozen(materialized));
    assert.ok(Object.isFrozen(materialized.calls));
    assert.ok(Object.isFrozen(materialized.nestedQueries));
    assert.ok(Object.isFrozen(materialized.typeConstructs));
  }
});

test("mixed concatenation preserves independent source order for each kind", (): void => {
  const firstCall = callNode(21);
  const firstNestedQuery = nestedQueryNode(22);
  const firstTypeConstruct = typeConstructNode(23);
  const secondCall = callNode(24);
  const secondTypeConstruct = typeConstructNode(25);
  const secondNestedQuery = nestedQueryNode(26);

  let sequence = emptySqlExpressionMetadataSequence();
  sequence = concatSqlExpressionMetadataSequences(
    sequence,
    sqlCallMetadataSequence(firstCall),
  );
  sequence = concatSqlExpressionMetadataSequences(
    sequence,
    sqlNestedQueryMetadataSequence(firstNestedQuery),
  );
  sequence = concatSqlExpressionMetadataSequences(
    sequence,
    sqlTypeConstructMetadataSequence(firstTypeConstruct),
  );
  sequence = concatSqlExpressionMetadataSequences(
    sequence,
    sqlCallMetadataSequence(secondCall),
  );
  sequence = concatSqlExpressionMetadataSequences(
    sequence,
    sqlTypeConstructMetadataSequence(secondTypeConstruct),
  );
  sequence = concatSqlExpressionMetadataSequences(
    sequence,
    sqlNestedQueryMetadataSequence(secondNestedQuery),
  );

  assert.equal(sequence.callCount, 2);
  assert.equal(sequence.nestedQueryCount, 2);
  assert.equal(sequence.typeConstructCount, 2);
  assert.deepEqual(materializeSqlExpressionMetadataSequence(sequence), {
    calls: [firstCall, secondCall],
    nestedQueries: [firstNestedQuery, secondNestedQuery],
    typeConstructs: [firstTypeConstruct, secondTypeConstruct],
  });
});

test("sequences and materialized arrays are immutable, owned, and non-mutating", (): void => {
  const call = callNode(31);
  const nestedQuery = nestedQueryNode(32);
  const callSequence = sqlCallMetadataSequence(call);
  const nestedQuerySequence = sqlNestedQueryMetadataSequence(nestedQuery);
  const joined = concatSqlExpressionMetadataSequences(
    callSequence,
    nestedQuerySequence,
  );
  const first = materializeSqlExpressionMetadataSequence(joined);
  const second = materializeSqlExpressionMetadataSequence(joined);

  assert.ok(Object.isFrozen(callSequence));
  assert.ok(Object.isFrozen(nestedQuerySequence));
  assert.ok(Object.isFrozen(joined));
  assert.equal(Reflect.set(joined, "callCount", 9), false);
  assert.equal(Reflect.set(first.calls, 0, callNode(99)), false);
  assert.equal(Reflect.set(first.calls, "length", 0), false);
  assert.notEqual(first, second);
  assert.notEqual(first.calls, second.calls);
  assert.notEqual(first.nestedQueries, second.nestedQueries);
  assert.notEqual(first.typeConstructs, second.typeConstructs);
  assert.equal(first.calls[0], call);
  assert.equal(second.calls[0], call);
  assert.equal(first.nestedQueries[0], nestedQuery);
  assert.equal(second.nestedQueries[0], nestedQuery);
  assert.equal(callSequence.callCount, 1);
  assert.equal(nestedQuerySequence.nestedQueryCount, 1);
  if (joined.kind !== "concat") {
    assert.fail("Non-empty sequence join must create a concat node");
  }
  assert.equal(joined.left, callSequence);
  assert.equal(joined.right, nestedQuerySequence);
});

test("empty concatenation remains canonical and allocation-free", (): void => {
  const firstEmpty = emptySqlExpressionMetadataSequence();
  const secondEmpty = emptySqlExpressionMetadataSequence();
  const leaf = sqlCallMetadataSequence(callNode(41));

  assert.equal(firstEmpty, secondEmpty);
  assert.equal(
    concatSqlExpressionMetadataSequences(firstEmpty, secondEmpty),
    firstEmpty,
  );
  assert.equal(
    concatSqlExpressionMetadataSequences(firstEmpty, leaf),
    leaf,
  );
  assert.equal(
    concatSqlExpressionMetadataSequences(leaf, firstEmpty),
    leaf,
  );
});

test("concat has constant structural work and retains both complete roots", (): void => {
  const leftLeaf = sqlCallMetadataSequence(callNode(51));
  const rightLeaf = sqlNestedQueryMetadataSequence(nestedQueryNode(52));
  let left = leftLeaf;
  let right = rightLeaf;

  for (let index = 1; index < 4_096; index++) {
    left = concatSqlExpressionMetadataSequences(left, leftLeaf);
  }
  for (let index = 1; index < 8_192; index++) {
    right = concatSqlExpressionMetadataSequences(rightLeaf, right);
  }

  const joined = concatSqlExpressionMetadataSequences(left, right);
  assert.equal(joined.kind, "concat");
  if (joined.kind !== "concat") {
    assert.fail("Non-empty sequence join must create a concat node");
  }
  assert.equal(joined.left, left);
  assert.equal(joined.right, right);
  assert.equal(joined.callCount, 4_096);
  assert.equal(joined.nestedQueryCount, 8_192);
  assert.equal(joined.typeConstructCount, 0);
  assert.ok(Object.isFrozen(joined));
});

test("100,000 left-associated nodes materialize iteratively", {
  timeout: 10_000,
}, (): void => {
  const nodeCount = 100_000;
  const call = callNode(61);
  const leaf = sqlCallMetadataSequence(call);
  let sequence = emptySqlExpressionMetadataSequence();

  for (let index = 0; index < nodeCount; index++) {
    sequence = concatSqlExpressionMetadataSequences(sequence, leaf);
  }

  const materialized = materializeSqlExpressionMetadataSequence(sequence);
  assert.equal(sequence.callCount, nodeCount);
  assert.equal(materialized.calls.length, nodeCount);
  assert.equal(materialized.nestedQueries.length, 0);
  assert.equal(materialized.typeConstructs.length, 0);
  assert.equal(materialized.calls[0], call);
  assert.equal(materialized.calls[nodeCount - 1], call);
});

test("100,000 right-associated nodes materialize iteratively", {
  timeout: 10_000,
}, (): void => {
  const nodeCount = 100_000;
  const nestedQuery = nestedQueryNode(71);
  const leaf = sqlNestedQueryMetadataSequence(nestedQuery);
  let sequence = emptySqlExpressionMetadataSequence();

  for (let index = 0; index < nodeCount; index++) {
    sequence = concatSqlExpressionMetadataSequences(leaf, sequence);
  }

  const materialized = materializeSqlExpressionMetadataSequence(sequence);
  assert.equal(sequence.nestedQueryCount, nodeCount);
  assert.equal(materialized.calls.length, 0);
  assert.equal(materialized.nestedQueries.length, nodeCount);
  assert.equal(materialized.typeConstructs.length, 0);
  assert.equal(materialized.nestedQueries[0], nestedQuery);
  assert.equal(materialized.nestedQueries[nodeCount - 1], nestedQuery);
});

test("materialization performs one ordered traversal into exact final arrays", (): void => {
  const eventCount = 30_000;
  const calls: Array<SqlCallNode> = [];
  const nestedQueries: Array<SqlNestedQueryNode> = [];
  const typeConstructs: Array<SqlTypeConstructNode> = [];
  let sequence = emptySqlExpressionMetadataSequence();

  for (let index = 0; index < eventCount; index++) {
    if (index % 3 === 0) {
      const node = callNode(index);
      calls.push(node);
      sequence = concatSqlExpressionMetadataSequences(
        sequence,
        sqlCallMetadataSequence(node),
      );
      continue;
    }
    if (index % 3 === 1) {
      const node = nestedQueryNode(index);
      nestedQueries.push(node);
      sequence = concatSqlExpressionMetadataSequences(
        sequence,
        sqlNestedQueryMetadataSequence(node),
      );
      continue;
    }
    const node = typeConstructNode(index);
    typeConstructs.push(node);
    sequence = concatSqlExpressionMetadataSequences(
      sequence,
      sqlTypeConstructMetadataSequence(node),
    );
  }

  const materialized = materializeSqlExpressionMetadataSequence(sequence);
  assert.equal(materialized.calls.length, sequence.callCount);
  assert.equal(
    materialized.nestedQueries.length,
    sequence.nestedQueryCount,
  );
  assert.equal(
    materialized.typeConstructs.length,
    sequence.typeConstructCount,
  );
  assert.deepEqual(materialized.calls, calls);
  assert.deepEqual(materialized.nestedQueries, nestedQueries);
  assert.deepEqual(materialized.typeConstructs, typeConstructs);
});

test("ordinary forged count violations fail with typed parser invariants", (): void => {
  const empty = emptySqlExpressionMetadataSequence();
  const invalidCounts: ReadonlyArray<number> = [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const callCount of invalidCounts) {
    const malformed: SqlExpressionMetadataSequence = {
      callCount,
      kind: "concat",
      left: empty,
      nestedQueryCount: 0,
      right: empty,
      typeConstructCount: 0,
    };
    expectMetadataInvariant(
      () => {
        materializeSqlExpressionMetadataSequence(malformed);
      },
      /call count must be a non-negative safe integer/u,
    );
  }

  const mismatched: SqlExpressionMetadataSequence = {
    callCount: 2,
    kind: "concat",
    left: sqlCallMetadataSequence(callNode(81)),
    nestedQueryCount: 0,
    right: empty,
    typeConstructCount: 0,
  };
  expectMetadataInvariant(
    () => {
      materializeSqlExpressionMetadataSequence(mismatched);
    },
    /call count is 2 but must be 1/u,
  );
});

test("ordinary malformed roots and concat children fail before dereference", (): void => {
  const empty = emptySqlExpressionMetadataSequence();
  const malformedRoots: ReadonlyArray<Readonly<{
    sequence: object | number | null;
    message: RegExp;
  }>> = [
    {
      message: /metadata sequence must be a non-null, non-array object/u,
      sequence: null,
    },
    {
      message: /metadata sequence must be a non-null, non-array object/u,
      sequence: 7,
    },
    {
      message: /metadata sequence must be a non-null, non-array object/u,
      sequence: [],
    },
    {
      message: /metadata sequence left child must be a non-null, non-array object/u,
      sequence: {
        callCount: 0,
        kind: "concat",
        left: null,
        nestedQueryCount: 0,
        right: empty,
        typeConstructCount: 0,
      },
    },
    {
      message: /metadata sequence right child must be a non-null, non-array object/u,
      sequence: {
        callCount: 0,
        kind: "concat",
        left: empty,
        nestedQueryCount: 0,
        typeConstructCount: 0,
      },
    },
    {
      message: /metadata sequence right child must be a non-null, non-array object/u,
      sequence: {
        callCount: 0,
        kind: "concat",
        left: empty,
        nestedQueryCount: 0,
        right: [],
        typeConstructCount: 0,
      },
    },
  ];

  for (const malformed of malformedRoots) {
    expectMetadataInvariant(
      () => {
        materializeMalformedSequence(malformed.sequence);
      },
      malformed.message,
    );
  }

  expectMetadataInvariant(
    () => {
      Reflect.apply(concatSqlExpressionMetadataSequences, null, [null, empty]);
    },
    /Left SQL expression metadata sequence must be a non-null, non-array object/u,
  );
});

test("every leaf kind requires a non-null object payload", (): void => {
  const malformedLeaves: ReadonlyArray<Readonly<{
    callCount: number;
    createSequence: SqlMetadataLeafConstructor;
    kind: "call" | "nested_query" | "type_construct";
    message: RegExp;
    nestedQueryCount: number;
    typeConstructCount: number;
  }>> = [
    {
      callCount: 1,
      createSequence: sqlCallMetadataSequence,
      kind: "call",
      message: /call node must be a non-null, non-array object/u,
      nestedQueryCount: 0,
      typeConstructCount: 0,
    },
    {
      callCount: 0,
      createSequence: sqlNestedQueryMetadataSequence,
      kind: "nested_query",
      message: /nested-query node must be a non-null, non-array object/u,
      nestedQueryCount: 1,
      typeConstructCount: 0,
    },
    {
      callCount: 0,
      createSequence: sqlTypeConstructMetadataSequence,
      kind: "type_construct",
      message: /type-construct node must be a non-null, non-array object/u,
      nestedQueryCount: 0,
      typeConstructCount: 1,
    },
  ];

  for (const malformed of malformedLeaves) {
    const missingPayload = {
      callCount: malformed.callCount,
      kind: malformed.kind,
      nestedQueryCount: malformed.nestedQueryCount,
      typeConstructCount: malformed.typeConstructCount,
    };
    expectMetadataInvariant(
      () => {
        materializeMalformedSequence(missingPayload);
      },
      malformed.message,
    );
    expectMetadataInvariant(
      () => {
        materializeMalformedSequence({ ...missingPayload, node: null });
      },
      malformed.message,
    );
    expectMetadataInvariant(
      () => {
        materializeMalformedSequence({ ...missingPayload, node: [] });
      },
      malformed.message,
    );
    expectMetadataInvariant(
      () => {
        createMalformedLeaf(malformed.createSequence, null);
      },
      malformed.message,
    );
  }
});

test("concat detects advertised count overflow without rescanning children", (): void => {
  const empty = emptySqlExpressionMetadataSequence();
  const inflatedLeaf: SqlExpressionMetadataSequence = {
    callCount: Number.MAX_SAFE_INTEGER,
    kind: "call",
    nestedQueryCount: 0,
    node: callNode(91),
    typeConstructCount: 0,
  };
  const inflatedRoot: SqlExpressionMetadataSequence = {
    callCount: Number.MAX_SAFE_INTEGER,
    kind: "concat",
    left: inflatedLeaf,
    nestedQueryCount: 0,
    right: empty,
    typeConstructCount: 0,
  };

  expectMetadataInvariant(
    () => {
      concatSqlExpressionMetadataSequences(
        inflatedRoot,
        sqlCallMetadataSequence(callNode(92)),
      );
    },
    /call count overflow while adding 9007199254740991 and 1/u,
  );
  expectMetadataInvariant(
    () => {
      materializeSqlExpressionMetadataSequence(inflatedRoot);
    },
    /exceeds maximum array length/u,
  );
});
