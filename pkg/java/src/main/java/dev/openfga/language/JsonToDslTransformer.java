package dev.openfga.language;

import com.fasterxml.jackson.core.JsonProcessingException;
import dev.openfga.language.errors.UnsupportedDSLNestingException;
import dev.openfga.sdk.api.model.*;

import java.util.*;
import java.util.function.Function;

import static java.util.Objects.requireNonNullElseGet;
import static java.util.stream.Collectors.joining;

public class JsonToDslTransformer {

    private static final String EOL = System.lineSeparator();

    public String transform(String json) throws JsonProcessingException {

        var model = JSON.parse(json, AuthorizationModel.class);

        return transformJSONToDSL(model);

    }

    private String transformJSONToDSL(AuthorizationModel model) {
        var schemaVersion = "1.1";
        if (model != null && model.getSchemaVersion() != null) {
            schemaVersion = model.getSchemaVersion();
        }

        var formattedTypeDefinitions = new StringBuilder();
        if (model != null && model.getTypeDefinitions() != null) {
            for (var typeDefinition : model.getTypeDefinitions()) {
                formattedTypeDefinitions.append(formatType(typeDefinition)).append(EOL);
            }
        }

        var fomattedConditions = formatConditions(model);

        return "model" + EOL + "  schema " + schemaVersion + EOL +
                formattedTypeDefinitions +
                fomattedConditions;
    }

    private String formatType(TypeDefinition typeDef) {
        var typeName = typeDef.getType();
        var formatedTypeBuilder = new StringBuilder(EOL).append("type ").append(typeName);

        var relations = requireNonNullElseGet(typeDef.getRelations(), HashMap<String, Userset>::new);
        var metadata = typeDef.getMetadata();
        var emptyMetadataRelation = new HashMap<String, RelationMetadata>();
        var metadataRelations = metadata != null ? metadata.getRelations() : emptyMetadataRelation;
        if (metadataRelations == null) {
            metadataRelations = emptyMetadataRelation;
        }

        if (!relations.isEmpty()) {
            formatedTypeBuilder
                    .append(EOL)
                    .append("  relations");
            for (var relationEntry :
                    relations.entrySet()) {
                var relationName = relationEntry.getKey();
                var relationDefinition = relationEntry.getValue();
                metadataRelations.get(relationName);
                var formattedRelationString = formatRelation(typeName, relationName, relationDefinition, metadataRelations.get(relationName));
                formatedTypeBuilder.append(EOL).append(formattedRelationString);
            }
        }

        return formatedTypeBuilder.toString();
    }

    private String formatRelation(String typeName, String relationName, Userset relationDefinition, RelationMetadata relationMetadata) {
        var formattedRelationBuilder = new StringBuilder("    define ").append(relationName).append(": ");
        var typeRestrictions = requireNonNullElseGet(relationMetadata.getDirectlyRelatedUserTypes(), ArrayList<RelationReference>::new);
        if (relationDefinition.getDifference() != null) {
            formattedRelationBuilder.append(formatDifference(typeName, relationName, relationDefinition, typeRestrictions));
        } else if (relationDefinition.getUnion() != null) {
            formattedRelationBuilder.append(formatUnion(typeName, relationName, relationDefinition, typeRestrictions));
        } else if (relationDefinition.getIntersection() != null) {
            formattedRelationBuilder.append(formatIntersection(typeName, relationName, relationDefinition, typeRestrictions));
        } else {
            formattedRelationBuilder.append(formatSubRelation(typeName, relationName, relationDefinition, typeRestrictions));
        }

        return formattedRelationBuilder.toString();
    }

    private StringBuilder formatDifference(String typeName, String relationName, Userset relationDefinition, List<RelationReference> typeRestrictions) {
        var base = formatSubRelation(typeName, relationName, relationDefinition.getDifference().getBase(), typeRestrictions);
        var difference = formatSubRelation(typeName, relationName, relationDefinition.getDifference().getSubtract(), typeRestrictions);

        return new StringBuilder(base).append(" but not ").append(difference);
    }

    private StringBuilder formatUnion(String typeName, String relationName, Userset relationDefinition, List<RelationReference> typeRestrictions) {
        return joinChildren(Userset::getUnion, "or", typeName, relationName, relationDefinition, typeRestrictions);
    }

    private StringBuilder formatIntersection(String typeName, String relationName, Userset relationDefinition, List<RelationReference> typeRestrictions) {
        return joinChildren(Userset::getIntersection, "and", typeName, relationName, relationDefinition, typeRestrictions);
    }

    private StringBuilder joinChildren(Function<Userset, Usersets> childrenAccessor, String operator, String typeName, String relationName, Userset relationDefinition, List<RelationReference> typeRestrictions) {
        List<Userset> children = null;
        if (relationDefinition != null && childrenAccessor.apply(relationDefinition) != null) {
            children = childrenAccessor.apply(relationDefinition).getChild();
        }
        children = requireNonNullElseGet(children, ArrayList::new);

        var formattedUnion = new StringBuilder();
        boolean notFirst = false;
        for (var child : children) {
            if (notFirst) {
                formattedUnion.append(" ").append(operator).append(" ");
            } else {
                notFirst = true;
            }
            formattedUnion.append(formatSubRelation(typeName, relationName, child, typeRestrictions));
        }

        return formattedUnion;
    }

    private static class DirectAssignmentValidator {
        private int occured = 0;
        private Deque<Userset> stateStack = new ArrayDeque<>();

        void incr() {
            occured++;
        }

        int occurences() {
            return occured;
        }

        void reset() {
            occured = 0;
            stateStack = new ArrayDeque<>();
        }
    }

    private final DirectAssignmentValidator validator = new DirectAssignmentValidator();


    private CharSequence formatSubRelation(String typeName, String relationName, Userset relationDefinition, List<RelationReference> typeRestrictions) {
        if (relationDefinition.getThis() != null) {
            validator.incr();
            return formatThis(typeRestrictions);
        }

        if (relationDefinition.getComputedUserset() != null) {
            return formatComputedUserset(relationDefinition);
        }

        if (relationDefinition.getTupleToUserset() != null) {
            return formatTupleToUserset(relationDefinition);
        }

        if (relationDefinition.getUnion() != null) {
            return formatUnion(typeName, relationName, relationDefinition, typeRestrictions)
                    .insert(0, '(')
                    .append(')');
        }

        if (relationDefinition.getIntersection() != null) {
            return formatIntersection(typeName, relationName, relationDefinition, typeRestrictions)
                    .insert(0, '(')
                    .append(')');
        }

        if (relationDefinition.getDifference() != null) {
            return formatDifference(typeName, relationName, relationDefinition, typeRestrictions)
                    .insert(0, '(')
                    .append(')');
        }

        throw new UnsupportedDSLNestingException(typeName, relationName);
    }

    private CharSequence formatThis(List<RelationReference> typeRestrictions) {
        return requireNonNullElseGet(typeRestrictions, ArrayList<RelationReference>::new)
                .stream()
                .map(this::formatTypeRestriction)
                .collect(joining(", ", "[", "]"));
    }

    private CharSequence formatTypeRestriction(RelationReference restriction) {
        var typeName = restriction.getType();
        var relation = restriction.getRelation();
        var wildcard = restriction.getWildcard();
        var condition = restriction.getCondition();

        var formattedTypeRestriction = new StringBuilder(typeName);

        if (wildcard != null) {
            formattedTypeRestriction.append(":*");
        }

        if (relation != null && !relation.isEmpty()) {
            formattedTypeRestriction.append('#').append(relation);
        }

        if (condition != null && !condition.isEmpty()) {
            formattedTypeRestriction.append(" with ").append(condition);
        }
        return formattedTypeRestriction;
    }

    private CharSequence formatComputedUserset(Userset relationDefinition) {
        return relationDefinition.getComputedUserset().getRelation();
    }

    private CharSequence formatTupleToUserset(Userset relationDefinition) {
        String computedUserset = "";
        String tupleset = "";
        if (relationDefinition != null && relationDefinition.getTupleToUserset() != null) {
            if (relationDefinition.getTupleToUserset().getComputedUserset() != null) {
                computedUserset = relationDefinition.getTupleToUserset().getComputedUserset().getRelation();
            }
            if (relationDefinition.getTupleToUserset().getTupleset() != null) {
                tupleset = relationDefinition.getTupleToUserset().getTupleset().getRelation();
            }
        }
        return new StringBuilder(computedUserset).append(" from ").append(tupleset);
    }

    private CharSequence formatConditions(AuthorizationModel model) {
        var conditions = model.getConditions();
        if (conditions == null || conditions.isEmpty()) {
            return "";
        }

        var formattedConditions = new StringBuilder();
        var sortedCondition = new TreeMap<>(conditions);

        for (var conditionEntry : sortedCondition.entrySet()) {
            var conditionName = conditionEntry.getKey();
            var conditionDef = conditionEntry.getValue();

            var formattedCondition = formatCondition(conditionName, conditionDef);
            formattedConditions.append(EOL).append(formattedCondition);
        }

        return formattedConditions;
    }

    private CharSequence formatCondition(String conditionName, Condition conditionDef) {
        if (!conditionName.equals(conditionDef.getName())) {
            throw new IllegalArgumentException("conditionName must match condition.getName()");
        }

        var formattedParameters = formatConditionParameters(conditionDef.getParameters());
        return new StringBuilder("condition ")
                .append(conditionDef.getName())
                .append('(')
                .append(formattedParameters)
                .append(") {")
                .append(EOL)
                .append("  ")
                .append(conditionDef.getExpression())
                .append(EOL)
                .append('}')
                .append(EOL);
    }

    private CharSequence formatConditionParameters(Map<String, ConditionParamTypeRef> parameters) {
        if (parameters == null || parameters.isEmpty()) {
            return "";
        }

        return new TreeMap<>(parameters).entrySet().stream()
                .map(entry -> {
                    var parameterName = entry.getKey();
                    var parameterType = entry.getValue();
                    var formattedParameterType = parameterType.getTypeName().getValue()
                            .replace("TYPE_NAME_", "")
                            .toLowerCase();
                    if (formattedParameterType.equals("list") || formattedParameterType.equals("map")) {
                        var genericTypeString = parameterType.getGenericTypes().get(0).getTypeName().getValue()
                                .replace("TYPE_NAME_", "")
                                .toLowerCase();
                        formattedParameterType = formattedParameterType + "<" + genericTypeString + ">";
                    }
                    return new StringBuilder(parameterName).append(": ").append(formattedParameterType);
                })
                .collect(joining(", "));
    }

}
