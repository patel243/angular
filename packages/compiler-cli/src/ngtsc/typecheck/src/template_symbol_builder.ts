/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AbsoluteSourceSpan, AST, ASTWithSource, BindingPipe, SafeMethodCall, SafePropertyRead, TmplAstBoundAttribute, TmplAstBoundEvent, TmplAstElement, TmplAstNode, TmplAstReference, TmplAstTemplate, TmplAstVariable} from '@angular/compiler';
import * as ts from 'typescript';

import {AbsoluteFsPath} from '../../file_system';
import {isAssignment} from '../../util/src/typescript';
import {DirectiveSymbol, ElementSymbol, ExpressionSymbol, InputBindingSymbol, OutputBindingSymbol, ReferenceSymbol, Symbol, SymbolKind, TemplateSymbol, TsNodeSymbolInfo, VariableSymbol} from '../api';

import {ExpressionIdentifier, findAllMatchingNodes, findFirstMatchingNode, hasExpressionIdentifier} from './comments';
import {TemplateData} from './context';
import {TcbDirectiveOutputsOp} from './type_check_block';


/**
 * A class which extracts information from a type check block.
 * This class is essentially used as just a closure around the constructor parameters.
 */
export class SymbolBuilder {
  constructor(
      private readonly typeChecker: ts.TypeChecker, private readonly shimPath: AbsoluteFsPath,
      private readonly typeCheckBlock: ts.Node, private readonly templateData: TemplateData) {}

  getSymbol(node: TmplAstTemplate|TmplAstElement): TemplateSymbol|ElementSymbol|null;
  getSymbol(node: TmplAstReference|TmplAstVariable): ReferenceSymbol|VariableSymbol|null;
  getSymbol(node: AST|TmplAstNode): Symbol|null;
  getSymbol(node: AST|TmplAstNode): Symbol|null {
    if (node instanceof TmplAstBoundAttribute) {
      // TODO(atscott): input and output bindings only return the first directive match but should
      // return a list of bindings for all of them.
      return this.getSymbolOfInputBinding(node);
    } else if (node instanceof TmplAstBoundEvent) {
      return this.getSymbolOfBoundEvent(node);
    } else if (node instanceof TmplAstElement) {
      return this.getSymbolOfElement(node);
    } else if (node instanceof TmplAstTemplate) {
      return this.getSymbolOfAstTemplate(node);
    } else if (node instanceof TmplAstVariable) {
      return this.getSymbolOfVariable(node);
    } else if (node instanceof TmplAstReference) {
      return this.getSymbolOfReference(node);
    } else if (node instanceof AST) {
      return this.getSymbolOfTemplateExpression(node);
    }
    // TODO(atscott): TmplAstContent, TmplAstIcu
    return null;
  }

  private getSymbolOfAstTemplate(template: TmplAstTemplate): TemplateSymbol|null {
    const directives = this.getDirectivesOfNode(template);
    return {kind: SymbolKind.Template, directives};
  }

  private getSymbolOfElement(element: TmplAstElement): ElementSymbol|null {
    const elementSourceSpan = element.startSourceSpan ?? element.sourceSpan;

    const node = findFirstMatchingNode(
        this.typeCheckBlock, {withSpan: elementSourceSpan, filter: ts.isVariableDeclaration});
    if (node === null) {
      return null;
    }

    const symbolFromDeclaration = this.getSymbolOfVariableDeclaration(node);
    if (symbolFromDeclaration === null || symbolFromDeclaration.tsSymbol === null) {
      return null;
    }

    const directives = this.getDirectivesOfNode(element);
    // All statements in the TCB are `Expression`s that optionally include more information.
    // An `ElementSymbol` uses the information returned for the variable declaration expression,
    // adds the directives for the element, and updates the `kind` to be `SymbolKind.Element`.
    return {
      ...symbolFromDeclaration,
      kind: SymbolKind.Element,
      directives,
    };
  }

  private getDirectivesOfNode(element: TmplAstElement|TmplAstTemplate): DirectiveSymbol[] {
    const elementSourceSpan = element.startSourceSpan ?? element.sourceSpan;
    const tcbSourceFile = this.typeCheckBlock.getSourceFile();
    const isDirectiveDeclaration = (node: ts.Node): node is ts.TypeNode => ts.isTypeNode(node) &&
        hasExpressionIdentifier(tcbSourceFile, node, ExpressionIdentifier.DIRECTIVE);

    const nodes = findAllMatchingNodes(
        this.typeCheckBlock, {withSpan: elementSourceSpan, filter: isDirectiveDeclaration});
    return nodes
        .map(node => {
          const symbol = this.getSymbolOfTsNode(node);
          if (symbol === null || symbol.tsSymbol === null) {
            return null;
          }
          const directiveSymbol:
              DirectiveSymbol = {...symbol, tsSymbol: symbol.tsSymbol, kind: SymbolKind.Directive};
          return directiveSymbol;
        })
        .filter((d): d is DirectiveSymbol => d !== null);
  }

  private getSymbolOfBoundEvent(eventBinding: TmplAstBoundEvent): OutputBindingSymbol|null {
    // Outputs are a `ts.CallExpression` that look like one of the two:
    // * _outputHelper(_t1["outputField"]).subscribe(handler);
    // * _t1.addEventListener(handler);
    const node = findFirstMatchingNode(
        this.typeCheckBlock, {withSpan: eventBinding.sourceSpan, filter: ts.isCallExpression});
    if (node === null) {
      return null;
    }

    const consumer = this.templateData.boundTarget.getConsumerOfBinding(eventBinding);
    if (consumer instanceof TmplAstTemplate || consumer instanceof TmplAstElement) {
      // Bindings to element or template events produce `addEventListener` which
      // we cannot get the field for.
      return null;
    }
    const outputFieldAccess = TcbDirectiveOutputsOp.decodeOutputCallExpression(node);
    if (outputFieldAccess === null) {
      return null;
    }

    const tsSymbol = this.typeChecker.getSymbolAtLocation(outputFieldAccess.argumentExpression);
    if (tsSymbol === undefined) {
      return null;
    }


    const target = this.getDirectiveSymbolForAccessExpression(outputFieldAccess);
    if (target === null) {
      return null;
    }

    const positionInShimFile = outputFieldAccess.argumentExpression.getStart();
    const tsType = this.typeChecker.getTypeAtLocation(node);
    return {
      kind: SymbolKind.Output,
      bindings: [{
        kind: SymbolKind.Binding,
        tsSymbol,
        tsType,
        target,
        shimLocation: {shimPath: this.shimPath, positionInShimFile},
      }],
    };
  }

  private getSymbolOfInputBinding(attributeBinding: TmplAstBoundAttribute): InputBindingSymbol
      |null {
    const node = findFirstMatchingNode(
        this.typeCheckBlock, {withSpan: attributeBinding.sourceSpan, filter: isAssignment});
    if (node === null) {
      return null;
    }

    let tsSymbol: ts.Symbol|undefined;
    let positionInShimFile: number|null = null;
    let tsType: ts.Type;
    if (ts.isElementAccessExpression(node.left)) {
      tsSymbol = this.typeChecker.getSymbolAtLocation(node.left.argumentExpression);
      positionInShimFile = node.left.argumentExpression.getStart();
      tsType = this.typeChecker.getTypeAtLocation(node.left.argumentExpression);
    } else if (ts.isPropertyAccessExpression(node.left)) {
      tsSymbol = this.typeChecker.getSymbolAtLocation(node.left.name);
      positionInShimFile = node.left.name.getStart();
      tsType = this.typeChecker.getTypeAtLocation(node.left.name);
    } else {
      return null;
    }
    if (tsSymbol === undefined || positionInShimFile === null) {
      return null;
    }

    const consumer = this.templateData.boundTarget.getConsumerOfBinding(attributeBinding);
    let target: ElementSymbol|TemplateSymbol|DirectiveSymbol|null;
    if (consumer instanceof TmplAstTemplate || consumer instanceof TmplAstElement) {
      target = this.getSymbol(consumer);
    } else {
      target = this.getDirectiveSymbolForAccessExpression(node.left);
    }

    if (target === null) {
      return null;
    }

    return {
      kind: SymbolKind.Input,
      bindings: [{
        kind: SymbolKind.Binding,
        tsSymbol,
        tsType,
        target,
        shimLocation: {shimPath: this.shimPath, positionInShimFile},
      }],
    };
  }

  private getDirectiveSymbolForAccessExpression(node: ts.ElementAccessExpression|
                                                ts.PropertyAccessExpression): DirectiveSymbol|null {
    // In either case, `_t1["index"]` or `_t1.index`, `node.expression` is _t1.
    // The retrieved symbol for _t1 will be the variable declaration.
    const tsSymbol = this.typeChecker.getSymbolAtLocation(node.expression);
    if (tsSymbol === undefined || tsSymbol.declarations.length === 0) {
      return null;
    }

    const [declaration] = tsSymbol.declarations;
    if (!ts.isVariableDeclaration(declaration) ||
        !hasExpressionIdentifier(
            // The expression identifier could be on the type (for regular directives) or the name
            // (for generic directives and the ctor op).
            declaration.getSourceFile(), declaration.type ?? declaration.name,
            ExpressionIdentifier.DIRECTIVE)) {
      return null;
    }

    const symbol = this.getSymbolOfVariableDeclaration(declaration);
    if (symbol === null || symbol.tsSymbol === null) {
      return null;
    }

    return {
      kind: SymbolKind.Directive,
      tsSymbol: symbol.tsSymbol,
      tsType: symbol.tsType,
      shimLocation: symbol.shimLocation,
    };
  }

  private getSymbolOfVariable(variable: TmplAstVariable): VariableSymbol|null {
    const node = findFirstMatchingNode(
        this.typeCheckBlock, {withSpan: variable.sourceSpan, filter: ts.isVariableDeclaration});
    if (node === null) {
      return null;
    }

    const expressionSymbol = this.getSymbolOfVariableDeclaration(node);
    if (expressionSymbol === null) {
      return null;
    }

    return {...expressionSymbol, kind: SymbolKind.Variable, declaration: variable};
  }

  private getSymbolOfReference(ref: TmplAstReference): ReferenceSymbol|null {
    const target = this.templateData.boundTarget.getReferenceTarget(ref);
    // Find the node for the reference declaration, i.e. `var _t2 = _t1;`
    let node = findFirstMatchingNode(
        this.typeCheckBlock, {withSpan: ref.sourceSpan, filter: ts.isVariableDeclaration});
    if (node === null || target === null || node.initializer === undefined) {
      return null;
    }

    // TODO(atscott): Shim location will need to be adjusted
    const symbol = this.getSymbolOfTsNode(node.name);
    if (symbol === null || symbol.tsSymbol === null) {
      return null;
    }

    if (target instanceof TmplAstTemplate || target instanceof TmplAstElement) {
      return {
        ...symbol,
        tsSymbol: symbol.tsSymbol,
        kind: SymbolKind.Reference,
        target,
        declaration: ref,
      };
    } else {
      if (!ts.isClassDeclaration(target.directive.ref.node)) {
        return null;
      }

      return {
        ...symbol,
        kind: SymbolKind.Reference,
        tsSymbol: symbol.tsSymbol,
        declaration: ref,
        target: target.directive.ref.node,
      };
    }
  }

  private getSymbolOfTemplateExpression(expression: AST): VariableSymbol|ReferenceSymbol
      |ExpressionSymbol|null {
    if (expression instanceof ASTWithSource) {
      expression = expression.ast;
    }

    const expressionTarget = this.templateData.boundTarget.getExpressionTarget(expression);
    if (expressionTarget !== null) {
      return this.getSymbol(expressionTarget);
    }

    let node = findFirstMatchingNode(
        this.typeCheckBlock,
        {withSpan: expression.sourceSpan, filter: (n: ts.Node): n is ts.Node => true});
    if (node === null) {
      return null;
    }

    while (ts.isParenthesizedExpression(node)) {
      node = node.expression;
    }

    // - If we have safe property read ("a?.b") we want to get the Symbol for b, the `whenTrue`
    // expression.
    // - If our expression is a pipe binding ("a | test:b:c"), we want the Symbol for the
    // `transform` on the pipe.
    // - Otherwise, we retrieve the symbol for the node itself with no special considerations
    if ((expression instanceof SafePropertyRead || expression instanceof SafeMethodCall) &&
        ts.isConditionalExpression(node)) {
      const whenTrueSymbol =
          (expression instanceof SafeMethodCall && ts.isCallExpression(node.whenTrue)) ?
          this.getSymbolOfTsNode(node.whenTrue.expression) :
          this.getSymbolOfTsNode(node.whenTrue);
      if (whenTrueSymbol === null) {
        return null;
      }

      return {
        ...whenTrueSymbol,
        kind: SymbolKind.Expression,
        // Rather than using the type of only the `whenTrue` part of the expression, we should
        // still get the type of the whole conditional expression to include `|undefined`.
        tsType: this.typeChecker.getTypeAtLocation(node)
      };
    } else if (expression instanceof BindingPipe && ts.isCallExpression(node)) {
      // TODO(atscott): Create a PipeSymbol to include symbol for the Pipe class
      const symbolInfo = this.getSymbolOfTsNode(node.expression);
      return symbolInfo === null ? null : {...symbolInfo, kind: SymbolKind.Expression};
    } else {
      const symbolInfo = this.getSymbolOfTsNode(node);
      return symbolInfo === null ? null : {...symbolInfo, kind: SymbolKind.Expression};
    }
  }

  private getSymbolOfTsNode(node: ts.Node): TsNodeSymbolInfo|null {
    while (ts.isParenthesizedExpression(node)) {
      node = node.expression;
    }

    let tsSymbol: ts.Symbol|undefined;
    let positionInShimFile: number;
    if (ts.isPropertyAccessExpression(node)) {
      tsSymbol = this.typeChecker.getSymbolAtLocation(node.name);
      positionInShimFile = node.name.getStart();
    } else {
      tsSymbol = this.typeChecker.getSymbolAtLocation(node);
      positionInShimFile = node.getStart();
    }

    const type = this.typeChecker.getTypeAtLocation(node);
    return {
      // If we could not find a symbol, fall back to the symbol on the type for the node.
      // Some nodes won't have a "symbol at location" but will have a symbol for the type.
      // One example of this would be literals.
      tsSymbol: tsSymbol ?? type.symbol ?? null,
      tsType: type,
      shimLocation: {shimPath: this.shimPath, positionInShimFile},
    };
  }

  private getSymbolOfVariableDeclaration(declaration: ts.VariableDeclaration): TsNodeSymbolInfo
      |null {
    // Instead of returning the Symbol for the temporary variable, we want to get the `ts.Symbol`
    // for:
    // - The type reference for `var _t2: MyDir = xyz` (prioritize/trust the declared type)
    // - The initializer for `var _t2 = _t1.index`.
    if (declaration.type && ts.isTypeReferenceNode(declaration.type)) {
      return this.getSymbolOfTsNode(declaration.type.typeName);
    }
    if (declaration.initializer === undefined) {
      return null;
    }

    const symbol = this.getSymbolOfTsNode(declaration.initializer);
    if (symbol === null) {
      return null;
    }

    return symbol;
  }
}
