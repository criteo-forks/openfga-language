package graph

import (
	"errors"

	"gonum.org/v1/gonum/graph"
	"gonum.org/v1/gonum/graph/encoding"
	"gonum.org/v1/gonum/graph/encoding/dot"
	"gonum.org/v1/gonum/graph/multi"
	"gonum.org/v1/gonum/graph/topo"
)

var ErrBuildingGraph = errors.New("cannot build graph")

type AuthorizationModelGraph struct {
	*multi.DirectedGraph
}

var _ dot.Attributers = (*AuthorizationModelGraph)(nil)

func (g *AuthorizationModelGraph) DOTAttributers() (encoding.Attributer, encoding.Attributer, encoding.Attributer) {
	return g, nil, nil
}

func (g *AuthorizationModelGraph) Attributes() []encoding.Attribute {
	// https://graphviz.org/docs/attrs/rankdir/ - bottom to top
	return []encoding.Attribute{{
		Key:   "rankdir",
		Value: "BT",
	}}
}

// GetDOT returns the DOT visualization. The output text is stable.
// It should only be used for debugging.
func (g *AuthorizationModelGraph) GetDOT() string {
	dotRepresentation, err := dot.MarshalMulti(g, "", "", "")
	if err != nil {
		return ""
	}

	return string(dotRepresentation)
}

// CycleInformation encapsulates whether the graph has cycles.
type CycleInformation struct {
	// If hasCyclesAtCompileTime is true, we should block this model from ever being written.
	// This is because we are trying to perform a Check on it will cause a stack overflow no matter what the tuples are.
	hasCyclesAtCompileTime bool

	// If canHaveCyclesAtRuntime is true, there could exist tuples that introduce a cycle.
	canHaveCyclesAtRuntime bool
}

func (g *AuthorizationModelGraph) nodeListHasNonComputedEdge(nodeList []graph.Node) bool {
	for i, nodeI := range nodeList {
		for _, nodeJ := range nodeList[i+1:] {
			allEdges := g.Lines(nodeI.ID(), nodeJ.ID())
			for allEdges.Next() {
				edge, ok := allEdges.Line().(*AuthorizationModelEdge)
				if ok && edge.edgeType != ComputedEdge {
					return true
				}
			}
		}
	}

	return false
}

func (g *AuthorizationModelGraph) GetCycles() CycleInformation {
	hasCyclesAtCompileTime := false
	hasCyclesAtRuntime := false

	// TODO: investigate whether len(1) should be identified as cycle

	nodes := topo.DirectedCyclesIn(g)
	for _, nodeList := range nodes {
		if g.nodeListHasNonComputedEdge(nodeList) {
			hasCyclesAtRuntime = true
		} else {
			hasCyclesAtCompileTime = true
		}
	}

	return CycleInformation{
		hasCyclesAtCompileTime: hasCyclesAtCompileTime,
		canHaveCyclesAtRuntime: hasCyclesAtRuntime,
	}
}

// TODO add graph traversals, etc.
