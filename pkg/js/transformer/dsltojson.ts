import OpenFGAListener from "../gen/OpenFGAParserListener";
import { AuthorizationModel, RelationMetadata, RelationReference, TypeDefinition, Userset } from "@openfga/sdk";
import * as antlr from "antlr4";
import OpenFGALexer from "../gen/OpenFGALexer";
import OpenFGAParser, {
  RelationDeclarationContext,
  RelationDefDirectAssignmentContext,
  RelationDefPartialAllAndContext,
  RelationDefPartialAllButNotContext,
  RelationDefPartialAllOrContext,
  RelationDefRelationOnRelatedObjectContext,
  RelationDefRelationOnSameObjectContext,
  RelationDefTypeRestrictionContext,
  SchemaVersionContext,
  TypeDefContext,
  TypeDefsContext,
} from "../gen/OpenFGAParser";
import { ErrorListener, RecognitionException, Recognizer } from "antlr4";
import { DSLSyntaxError, DSLSyntaxSingleError } from "../errors";

enum RelationDefinitionOperator {
  RELATION_DEFINITION_OPERATOR_NONE = "",
  RELATION_DEFINITION_OPERATOR_OR = "or",
  RELATION_DEFINITION_OPERATOR_AND = "and",
  RELATION_DEFINITION_OPERATOR_BUT_NOT = "but not",
}

type RelationTypeInfo = RelationMetadata;

interface Relation {
  name: string;
  rewrites: Userset[];
  operator: RelationDefinitionOperator;
  typeInfo: RelationTypeInfo;
}

/**
 * This Visitor walks the tree generated by parsers and produces Python code
 *
 * @returns {object}
 */
class OpenFgaDslListener extends OpenFGAListener {
  public authorizationModel: Partial<AuthorizationModel> = {};
  private currentTypeDef: Partial<TypeDefinition> | undefined;
  private currentRelation: Partial<Relation> | undefined;

  exitSchemaVersion = (ctx: SchemaVersionContext) => {
    this.authorizationModel.schema_version = ctx.getText();
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterTypeDefs = (_ctx: TypeDefsContext) => {
    this.authorizationModel.type_definitions = [];
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  exitTypeDefs = (_ctx: TypeDefsContext) => {
    if (!this.authorizationModel.type_definitions?.length) {
      delete this.authorizationModel.type_definitions;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterTypeDef = (ctx: TypeDefContext) => {
    if (!ctx.typeName()) {
      return;
    }

    this.currentTypeDef = {
      type: ctx.typeName().getText(),
      relations: {},
      metadata: { relations: {} },
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  exitTypeDef = (ctx: TypeDefContext) => {
    if (!this.currentTypeDef?.type) {
      return;
    }

    if (!Object.keys(this.currentTypeDef?.metadata?.relations || {}).length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.currentTypeDef!.metadata = null as any;
    }

    this.authorizationModel.type_definitions?.push(this.currentTypeDef as TypeDefinition);
    this.currentTypeDef = undefined;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterRelationDeclaration = (_ctx: RelationDeclarationContext) => {
    this.currentRelation = {
      rewrites: [],
      typeInfo: { directly_related_user_types: [] },
    };
  };

  exitRelationDeclaration = (ctx: RelationDeclarationContext) => {
    if (!ctx.relationName()) {
      return;
    }

    const relationName = ctx.relationName().getText();
    let relationDef: Userset | undefined;
    const rewrites = this.currentRelation?.rewrites;
    if (!rewrites?.length) {
      return;
    }
    if (rewrites?.length === 1) {
      relationDef = rewrites[0];
    } else {
      switch (this.currentRelation?.operator) {
        case RelationDefinitionOperator.RELATION_DEFINITION_OPERATOR_OR:
          relationDef = {
            union: {
              child: rewrites,
            },
          };
          break;
        case RelationDefinitionOperator.RELATION_DEFINITION_OPERATOR_AND:
          relationDef = {
            intersection: {
              child: rewrites,
            },
          };
          break;
        case RelationDefinitionOperator.RELATION_DEFINITION_OPERATOR_BUT_NOT:
          relationDef = {
            difference: {
              base: rewrites![0],
              subtract: rewrites![1],
            },
          };
          break;
      }
    }
    if (relationDef) {
      // Throw error if same named relation occurs more than once in a relationship definition block
      if (this.currentTypeDef!.relations![relationName]) {
        ctx.parser?.notifyErrorListeners(
          `'${relationName}' is already defined in '${this.currentTypeDef?.type}'`,
          ctx.relationName().start,
          undefined
        );
      }

      this.currentTypeDef!.relations![relationName] = relationDef;
      const directlyRelatedUserTypes = this.currentRelation?.typeInfo?.directly_related_user_types;
      this.currentTypeDef!.metadata!.relations![relationName] = {
        directly_related_user_types: directlyRelatedUserTypes,
      };
    }

    this.currentRelation = undefined;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterRelationDefDirectAssignment = (_ctx: RelationDefDirectAssignmentContext) => {
    this.currentRelation!.typeInfo = { directly_related_user_types: [] };
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  exitRelationDefDirectAssignment = (_ctx: RelationDefDirectAssignmentContext) => {
    const partialRewrite: Userset = {
      this: {},
    };
    this.currentRelation?.rewrites?.push(partialRewrite);
  };
  exitRelationDefTypeRestriction = (ctx: RelationDefTypeRestrictionContext) => {
    const relationRef: Partial<RelationReference> = {};
    const type = ctx.relationDefTypeRestrictionType();

    const usersetRestriction = ctx.relationDefTypeRestrictionUserset();
    const wildcardRestriction = ctx.relationDefTypeRestrictionWildcard();
    if (type) {
      relationRef.type = type.getText();
    }
    if (usersetRestriction) {
      relationRef.type = usersetRestriction.relationDefTypeRestrictionType().getText();
      relationRef.relation = usersetRestriction.relationDefTypeRestrictionRelation().getText();
    }
    if (wildcardRestriction) {
      relationRef.type = wildcardRestriction.relationDefTypeRestrictionType().getText();
      relationRef.wildcard = {};
    }
    this.currentRelation!.typeInfo!.directly_related_user_types!.push(relationRef as RelationReference);
  };

  exitRelationDefRelationOnSameObject = (ctx: RelationDefRelationOnSameObjectContext) => {
    const partialRewrite: Userset = {
      computedUserset: {
        object: "",
        relation: ctx.rewriteComputedusersetName().getText(),
      },
    };
    this.currentRelation?.rewrites?.push(partialRewrite);
  };

  exitRelationDefRelationOnRelatedObject = (ctx: RelationDefRelationOnRelatedObjectContext) => {
    const partialRewrite: Userset = {
      tupleToUserset: {
        computedUserset: {
          object: "",
          relation: ctx.rewriteTuplesetComputedusersetName().getText(),
        },
        tupleset: {
          object: "",
          relation: ctx.rewriteTuplesetName().getText(),
        },
      },
    };
    this.currentRelation?.rewrites?.push(partialRewrite);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterRelationDefPartialAllOr = (_ctx: RelationDefPartialAllOrContext) => {
    this.currentRelation!.operator = RelationDefinitionOperator.RELATION_DEFINITION_OPERATOR_OR;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterRelationDefPartialAllAnd = (_ctx: RelationDefPartialAllAndContext) => {
    this.currentRelation!.operator = RelationDefinitionOperator.RELATION_DEFINITION_OPERATOR_AND;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  enterRelationDefPartialAllButNot = (_ctx: RelationDefPartialAllButNotContext) => {
    this.currentRelation!.operator = RelationDefinitionOperator.RELATION_DEFINITION_OPERATOR_BUT_NOT;
  };
}

class OpenFgaDslErrorListener<T> extends ErrorListener<T> {
  errors: DSLSyntaxSingleError[] = [];

  syntaxError(
    recognizer: Recognizer<T>,
    offendingSymbol: T,
    line: number,
    column: number,
    msg: string,
    e: RecognitionException | undefined,
  ) {
    let metadata = undefined;
    let columnOffset = 0;

    if (offendingSymbol instanceof antlr.Token) {
      metadata = {
        symbol: offendingSymbol.text,
      };
      columnOffset = metadata.symbol.length;
    }

    this.errors.push(
      new DSLSyntaxSingleError(
        {
          line: { start: line, end: line },
          column: { start: column, end: column + columnOffset },
          msg,
        },
        metadata,
        e,
      ),
    );
  }
}

export function parseDSL(data: string): {
  listener: OpenFgaDslListener;
  errorListener: OpenFgaDslErrorListener<unknown>;
} {
  const cleanedData = data
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  const is = new antlr.InputStream(cleanedData);

  const errorListener = new OpenFgaDslErrorListener();

  // Create the Lexer
  const lexer = new OpenFGALexer(is as antlr.CharStream);
  lexer.removeErrorListeners();
  lexer.addErrorListener(errorListener);
  const stream = new antlr.CommonTokenStream(lexer);

  // Create the Parser
  const parser = new OpenFGAParser(stream);
  parser.removeErrorListeners();
  parser.addErrorListener(errorListener);

  // Finally parse the expression
  const listener = new OpenFgaDslListener();
  new antlr.ParseTreeWalker().walk(listener, parser.main());

  return { listener, errorListener };
}

/**
 * transformDSLToJSON - Converts models authored in FGA DSL syntax to the json syntax accepted by the OpenFGA API
 * @param {string} data
 * @returns {AuthorizationModel}
 */
export function transformDSLToJSON(data: string): AuthorizationModel {
  const { listener, errorListener } = parseDSL(data);

  if (errorListener.errors.length) {
    throw new DSLSyntaxError(errorListener.errors);
  }

  return listener.authorizationModel as AuthorizationModel;
}
