// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import * as ts from "typescript";
import * as log from "../../log";
import * as closure from "./createClosure";

export interface ParsedFunctionCode {
    // The serialized code for the function, usable as an expression. Valid for all functions forms
    // (functions, lambdas, methods, etc.).
    funcExprWithoutName: string;

    // The serialized code for the function, usable as an function-declaration. Valid only for
    // non-lambda function forms.
    funcExprWithName?: string;

    // the name of the function if it was a function-declaration.  This is needed so
    // that we can include an entry in the environment mapping this function name to
    // the actual function we generate for it.  This is needed so that nested recursive calls
    // to the function see the function we're generating.
    functionDeclarationName?: string;

    // Whether or not this was an arrow function.
    isArrowFunction: boolean;
}

export interface ParsedFunction extends ParsedFunctionCode {
    // The set of variables the function attempts to capture
    capturedVariables: CapturedVariables;

    // Whether or not the real 'this' (i.e. not a lexically captured this) is used in the function.
    usesNonLexicalThis: boolean;
}

// Information about a captured property.  Both the name and whether or not the property was
// invoked.
export interface CapturedPropertyInfo {
    name: string;
    invoked: boolean;
}

export interface CapturedVariableMap extends Record<string, CapturedPropertyInfo[]> {
}

// The set of variables the function attempts to capture.  There is a required set an an optional
// set. The optional set will not block closure-serialization if we cannot find them, while the
// required set will.  For each variable that is captured we also specify the list of properties of
// that variable we need to serialize.  An empty-list means 'serialize all properties'.
export interface CapturedVariables {
    required: CapturedVariableMap;
    optional: CapturedVariableMap;
}

const nodeModuleGlobals: {[key: string]: boolean} = {
    "__dirname": true,
    "__filename": true,
    "exports": true,
    "module": true,
    "require": true,
};

// Gets the text of the provided function (using .toString()) and massages it so that it is a legal
// function declaration.  Note: this ties us heavily to V8 and its representation for functions.  In
// particular, it has expectations around how functions/lambdas/methods/generators/constructors etc.
// are represented.  If these change, this will likely break us.zs
export function parseFunction(funcString: string): [string, ParsedFunction] {
    const [error, functionCode] = parseFunctionCode(funcString);
    if (error) {
        return [error, <any>undefined];
    }

    const file = createSourceFile(functionCode);

    const capturedVariables = computeCapturedVariableNames(file);

    // if we're looking at an arrow function, the it is always using lexical 'this's
    // so we don't have to bother even examining it.
    const usesNonLexicalThis = !functionCode.isArrowFunction && computeUsesNonLexicalThis(file);

    const result = <ParsedFunction>functionCode;
    result.capturedVariables = capturedVariables;
    result.usesNonLexicalThis = usesNonLexicalThis;

    if (result.capturedVariables.required.this) {
        return [
            "arrow function captured 'this'. Assign 'this' to another name outside function and capture that.",
            result,
        ];
    }

    return ["", result];
}

function parseFunctionCode(funcString: string): [string, ParsedFunctionCode] {
    if (funcString.startsWith("[Function:")) {
        return [`the function form was not understood.`, <any>undefined];
    }

    if (funcString.indexOf("[native code]") !== -1) {
        return [`it was a native code function.`, <any>undefined];
    }

    // We need to ensure that lambdas stay lambdas, and non-lambdas end up looking like functions.
    // This will make it so that we can correctly handle 'this' properly depending on if that should
    // be treated as the lexical capture of 'this' or hte non-lexical 'this'.
    //
    // It might seem like we could just look at the first character of the string to see if it is a
    // '('.  However, that's insufficient due to how v8 generates strings for some functions.
    // Specifically we have to consider the following cases.
    //
    //      (...) { }       // i.e. a function with a *computed* property name.
    //      (...) => { }    // lambda with a block body
    //      (...) => expr   // lambda with an expression body.
    //
    // First we check if we have a open curly or not.  If we don't, then we're in the last case. We
    // confirm that we have a => (throwing if we don't).
    //
    // If we do have an open curly, then we're in one of the top two cases.  To determine which we
    // trim things up to the open curly, leaving us with either:
    //
    //      (...) {
    //      (...) => {
    //
    // We then see if we have an => or not.  if we do, it's a lambda.  If we don't, it's a function
    // with a computed name.

    const openCurlyIndex = funcString.indexOf("{");
    if (openCurlyIndex < 0) {
        // No block body.  Can happen if this is an arrow function with an expression body.
        const arrowIndex = funcString.indexOf("=>");
        if (arrowIndex >= 0) {
            // (...) => expr
            return ["", { funcExprWithoutName: funcString, isArrowFunction: true }];
        }

        return [`the function form was not understood.`, <any>undefined];
    }

    const signature = funcString.substr(0, openCurlyIndex);
    if (signature.indexOf("=>") >= 0) {
        // (...) => { ... }
        return ["", { funcExprWithoutName: funcString, isArrowFunction: true }];
    }

    if (funcString.startsWith("function get ") || funcString.startsWith("function set ")) {
        const trimmed = funcString.substr("function get".length);
        return makeFunctionDeclaration(trimmed, /*isFunctionDeclaration: */ false);
    }

    if (funcString.startsWith("function")) {
        const trimmed = funcString.substr("function".length);
        return makeFunctionDeclaration(trimmed, /*isFunctionDeclaration: */ true);
    }

    if (funcString.startsWith("class ")) {
        // class constructor function.  We want to get the actual constructor
        // in the class definition (synthesizing an empty one if one does not)
        // exist.
        const file = ts.createSourceFile("", funcString, ts.ScriptTarget.Latest);
        const diagnostics: ts.Diagnostic[] = (<any>file).parseDiagnostics;
        if (diagnostics.length) {
            return [`the class could not be parsed: ${diagnostics[0].messageText}`, <any>undefined];
        }

        const classDecl = <ts.ClassDeclaration>file.statements.find(x => ts.isClassDeclaration(x));
        if (!classDecl) {
            return [`the class form was not understood:\n${funcString}`, <any>undefined];
        }

        const constructor = <ts.ConstructorDeclaration>classDecl.members.find(m => ts.isConstructorDeclaration(m));
        if (!constructor) {
            // class without explicit constructor.
            const isSubClass = classDecl.heritageClauses && classDecl.heritageClauses.some(
                c => c.token === ts.SyntaxKind.ExtendsKeyword);
            return isSubClass
                ? makeFunctionDeclaration("constructor() { super(); }", /*isFunctionDeclaration: */ false)
                : makeFunctionDeclaration("constructor() { }", /*isFunctionDeclaration: */ false);
        }

        const constructorCode = funcString.substring(constructor.pos, constructor.end).trim();
        return makeFunctionDeclaration(constructorCode, /*isFunctionDeclaration: */ false);
    }

    // Add "function" (this will make methods parseable).  i.e.  "foo() { }" becomes
    // "function foo() { }"
    // this also does the right thing for functions with computed names.
    return makeFunctionDeclaration(funcString, /*isFunctionDeclaration: */ false);

    function makeFunctionDeclaration(v: string, isFunctionDeclaration: boolean): [string, ParsedFunctionCode] {
        let prefix = "function ";
        v = v.trimLeft();

        if (v.startsWith("*")) {
            v = v.substr(1).trimLeft();
            prefix = "function* ";
        }

        const openParenIndex = v.indexOf("(");
        if (openParenIndex < 0) {
            return [`the function form was not understood.`, <any>undefined];
        }

        if (openParenIndex === 0) {
            return ["", {
                funcExprWithoutName: prefix + v,
                funcExprWithName: prefix + "__computed" + v,
                functionDeclarationName: undefined,
                isArrowFunction: false,
            }];
        }

        const nameChunk = v.substr(0, openParenIndex);
        const funcName = closure.isLegalMemberName(nameChunk)
            ? closure.isLegalFunctionName(nameChunk) ? nameChunk : "/*" + nameChunk + "*/"
            : "";
        const commentedName = closure.isLegalMemberName(nameChunk) ? "/*" + nameChunk + "*/" : "";
        v = v.substr(openParenIndex).trimLeft();

        return ["", {
            funcExprWithoutName: prefix + commentedName + v,
            funcExprWithName: prefix + funcName + v,
            functionDeclarationName: isFunctionDeclaration ? nameChunk : undefined,
            isArrowFunction: false,
        }];
    }
}

function createSourceFile(serializedFunction: ParsedFunctionCode): ts.SourceFile {
    const funcstr = serializedFunction.funcExprWithName || serializedFunction.funcExprWithoutName;

    // Wrap with parens to make into something parseable.  This is necessary as many
    // types of functions are valid function expressions, but not valid function
    // declarations.  i.e.   "function () { }".  This is not a valid function declaration
    // (it's missing a name).  But it's totally legal as "(function () { })".
    const toParse = "(" + funcstr + ")";

    const file = ts.createSourceFile(
        "", toParse, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics: ts.Diagnostic[] = (<any>file).parseDiagnostics;
    if (diagnostics.length) {
        throw new Error(`Could not parse function: ${diagnostics[0].messageText}\n${toParse}`);
    }

    return file;
}

function computeUsesNonLexicalThis(file: ts.SourceFile): boolean {
    let inTopmostFunction = false;
    let usesNonLexicalThis = false;

    ts.forEachChild(file, walk);

    return usesNonLexicalThis;

    function walk(node: ts.Node | undefined) {
        if (!node) {
            return;
        }

        switch (node.kind) {
            case ts.SyntaxKind.SuperKeyword:
            case ts.SyntaxKind.ThisKeyword:
                usesNonLexicalThis = true;
                break;

            case ts.SyntaxKind.CallExpression:
                return visitCallExpression(<ts.CallExpression>node);

            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
                return visitBaseFunction(<ts.FunctionLikeDeclarationBase>node);

            // Note: it is intentional that we ignore ArrowFunction.  If we use 'this' inside of it,
            // then that should be considered a use of the non-lexical-this from an outer function.
            // i.e.
            //          function f() { var v = () => console.log(this) }
            //
            // case ts.SyntaxKind.ArrowFunction:
            default:
                break;
        }

        ts.forEachChild(node, walk);
    }

    function visitBaseFunction(node: ts.FunctionLikeDeclarationBase): void {
        if (inTopmostFunction) {
            // we're already in the topmost function.  No need to descend into any
            // further functions.
            return;
        }

        // Entering the topmost function.
        inTopmostFunction = true;

        // Now, visit its body to see if we use 'this/super'.
        walk(node.body);

        inTopmostFunction = false;
    }

    function visitCallExpression(node: ts.CallExpression) {
        // Most call expressions are normal.  But we must special case one kind of function:
        // TypeScript's __awaiter functions.  They are of the form `__awaiter(this, void 0, void 0,
        // function* (){})`,

        // The first 'this' argument is passed along in case the expression awaited uses 'this'.
        // However, doing that can be very bad for us as in many cases the 'this' just refers to the
        // surrounding module, and the awaited expression won't be using that 'this' at all.
        walk(node.expression);

        if (isAwaiterCall(node)) {
            const lastFunction = <ts.FunctionExpression>node.arguments[3];
            walk(lastFunction.body);
            return;
        }

        // For normal calls, just walk all arguments normally.
        for (const arg of node.arguments) {
            walk(arg);
        }
    }
}

/**
 * computeCapturedVariableNames computes the set of free variables in a given function string.  Note that this string is
 * expected to be the usual V8-serialized function expression text.
 */
function computeCapturedVariableNames(file: ts.SourceFile): CapturedVariables {
    // Now that we've parsed the file, compute the free variables, and return them.

    let required: CapturedVariableMap = {};
    let optional: CapturedVariableMap = {};
    const scopes: Set<string>[] = [];
    let functionVars: Set<string> = new Set();

    // Recurse through the tree.  We use typescript's AST here and generally walk the entire
    // tree. One subtlety to be aware of is that we generally assume that when we hit an
    // identifier that it either introduces a new variable, or it lexically references a
    // variable.  This clearly doesn't make sense for *all* identifiers.  For example, if you
    // have "console.log" then "console" tries to lexically reference a variable, but "log" does
    // not.  So, to avoid that being an issue, we carefully decide when to recurse.  For
    // example, for member access expressions (i.e. A.B) we do not recurse down the right side.

    ts.forEachChild(file, walk);

    // Now just return all variables whose value is true.  Filter out any that are part of the built-in
    // Node.js global object, however, since those are implicitly availble on the other side of serialization.
    const result: CapturedVariables = { required: {}, optional: {} };

    for (const key of Object.keys(required)) {
        if (required[key] && !isBuiltIn(key)) {
            result.required[key] = required[key].concat(
                optional.hasOwnProperty(key) ? optional[key] : []);
        }
    }

    for (const key of Object.keys(optional)) {
        if (optional[key] && !isBuiltIn(key) && !required[key]) {
            result.optional[key] = optional[key];
        }
    }

    // console.log("Free variables for:\n" + serializedFunction.funcExprWithName  +
    //     "\n" + JSON.stringify(result));
    log.debug(`Found free variables: ${JSON.stringify(result)}`);
    return result;

    function isBuiltIn(ident: string): boolean {
        // Anything in the global dictionary is a built-in.  So is anything that's a global Node.js object;
        // note that these only exist in the scope of modules, and so are not truly global in the usual sense.
        // See https://nodejs.org/api/globals.html for more details.
        return global.hasOwnProperty(ident) || nodeModuleGlobals[ident];
    }

    function currentScope(): Set<string> {
        return scopes[scopes.length - 1];
    }

    function visitIdentifier(node: ts.Identifier): void {
        // Remember undeclared identifiers during the walk, as they are possibly free.
        const name = node.text;
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].has(name)) {
                // This is currently known in the scope chain, so do not add it as free.
                return;
            }
        }

        // We reached the top of the scope chain and this wasn't found; it's captured.
        const capturedProperty = determineCapturedPropertyInfo(node);
        if (node.parent!.kind === ts.SyntaxKind.TypeOfExpression) {
            // "typeof undeclared_id" is legal in JS (and is actually used in libraries). So keep
            // track that we would like to capture this variable, but mark that capture as optional
            // so we will not throw if we aren't able to find it in scope.
            optional[name] = combineProperties(optional[name], capturedProperty);
        } else {
            required[name] = combineProperties(required[name], capturedProperty);
        }
    }

    function walk(node: ts.Node | undefined) {
        if (!node) {
            return;
        }

        switch (node.kind) {
            case ts.SyntaxKind.Identifier:
                return visitIdentifier(<ts.Identifier>node);
            case ts.SyntaxKind.ThisKeyword:
                return visitThisExpression(<ts.ThisExpression>node);
            case ts.SyntaxKind.Block:
                return visitBlockStatement(<ts.Block>node);
            case ts.SyntaxKind.CallExpression:
                return visitCallExpression(<ts.CallExpression>node);
            case ts.SyntaxKind.CatchClause:
                return visitCatchClause(<ts.CatchClause>node);
            case ts.SyntaxKind.MethodDeclaration:
                return visitMethodDeclaration(<ts.MethodDeclaration>node);
            case ts.SyntaxKind.MetaProperty:
                // don't walk down an es6 metaproperty (i.e. "new.target").  It doesn't
                // capture anything.
                return;
            case ts.SyntaxKind.PropertyAssignment:
                return visitPropertyAssignment(<ts.PropertyAssignment>node);
            case ts.SyntaxKind.PropertyAccessExpression:
                return visitPropertyAccessExpression(<ts.PropertyAccessExpression>node);
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
                return visitFunctionDeclarationOrExpression(<ts.FunctionDeclaration>node);
            case ts.SyntaxKind.ArrowFunction:
                return visitBaseFunction(<ts.ArrowFunction>node, /*isArrowFunction:*/true, /*name:*/ undefined);
            case ts.SyntaxKind.VariableDeclaration:
                return visitVariableDeclaration(<ts.VariableDeclaration>node);
            default:
                break;
        }

        ts.forEachChild(node, walk);
    }

    function visitThisExpression(node: ts.ThisExpression): void {
        required["this"] = combineProperties(required["this"], determineCapturedPropertyInfo(node));
    }

    function combineProperties(existing: CapturedPropertyInfo[] | undefined,
                               current: CapturedPropertyInfo | undefined) {
        if (existing && existing.length === 0) {
            // We already want to capture everything.  Keep things that way.
            return existing;
        }

        if (current === undefined) {
            // We want to capture everything.  So ignore any properties we've filtered down
            // to and just capture them all.
            return [];
        }

        // We want to capture a specific set of properties.  Add this set of properties
        // into the existing set.
        const combined = existing || [];

        // See if we've already marked this property as captured.  If so, make sure we still record
        // if this property was invoked or not.
        for (const existingProp of combined) {
            if (existingProp.name === current.name) {
                existingProp.invoked = existingProp.invoked || current.invoked;
                return combined;
            }
        }

        // Haven't seen this property.  Record that we're capturing it.
        combined.push(current);
        return combined;
    }

    function determineCapturedPropertyInfo(node: ts.Node): CapturedPropertyInfo | undefined {
        if (node.parent &&
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.expression === node) {

            const propertyAccess = <ts.PropertyAccessExpression>node.parent;
            const invoked = propertyAccess.parent !== undefined &&
                            ts.isCallExpression(propertyAccess.parent) &&
                            propertyAccess.parent.expression === propertyAccess;

            return { name: node.parent.name.text, invoked };
        }

        // For all other cases, capture everything.
        return undefined;
    }

    function visitBlockStatement(node: ts.Block): void {
        // Push new scope, visit all block statements, and then restore the scope.
        scopes.push(new Set());
        ts.forEachChild(node, walk);
        scopes.pop();
    }

    function visitFunctionDeclarationOrExpression(
            node: ts.FunctionDeclaration | ts.FunctionExpression): void {
        // A function declaration is special in one way: its identifier is added to the current function's
        // var-style variables, so that its name is in scope no matter the order of surrounding references to it.

        if (node.name) {
            functionVars.add(node.name.text);
        }

        visitBaseFunction(node, /*isArrowFunction:*/false, node.name);
    }

    function visitBaseFunction(
            node: ts.FunctionLikeDeclarationBase,
            isArrowFunction: boolean,
            functionName: ts.Identifier | undefined): void {
        // First, push new free vars list, scope, and function vars
        const savedRequired = required;
        const savedOptional = optional;
        const savedFunctionVars = functionVars;

        required = {};
        optional = {};
        functionVars = new Set();
        scopes.push(new Set());

        // If this is a named function, it's name is in scope at the top level of itself.
        if (functionName) {
            functionVars.add(functionName.text);
        }

        // this/arguments are in scope inside any non-arrow function.
        if (!isArrowFunction) {
            functionVars.add("this");
            functionVars.add("arguments");
        }

        // The parameters of any function are in scope at the top level of the function.
        for (const param of node.parameters) {
            nameWalk(param.name, /*isVar:*/ true);
        }

        // Next, visit the body underneath this new context.
        walk(node.body);

        // Remove any function-scoped variables that we encountered during the walk.
        for (const v of functionVars) {
            delete required[v];
            delete optional[v];
        }

        // Restore the prior context and merge our free list with the previous one.
        scopes.pop();

        mergeMaps(savedRequired, required);
        mergeMaps(savedOptional, optional);

        functionVars = savedFunctionVars;
        required = savedRequired;
        optional = savedOptional;
    }

    // Record<string, CapturedPropertyInfo[]>
    function mergeMaps(target: CapturedVariableMap, source: CapturedVariableMap) {
        for (const key of Object.keys(source)) {
            const sourcePropInfos = source[key];
            let targetPropInfos = target[key];

            if (sourcePropInfos.length === 0) {
                // we want to capture everything.  Make sure that's reflected in the target.
                targetPropInfos = [];
            }
            else {
                // we want to capture a subet of properties.  merge that subset into whatever
                // subset we've recorded so far.
                for (const sourceInfo of sourcePropInfos) {
                    targetPropInfos = combineProperties(targetPropInfos, sourceInfo);
                }
            }

            target[key] = targetPropInfos;
        }
    }

    function visitCatchClause(node: ts.CatchClause): void {
        scopes.push(new Set());

        // Add the catch pattern to the scope as a variable.  Note that it is scoped to our current
        // fresh scope (so it can't be seen by the rest of the function).
        if (node.variableDeclaration) {
            nameWalk(node.variableDeclaration.name, /*isVar:*/ false);
        }

        // And then visit the block without adding them as free variables.
        walk(node.block);

        // Relinquish the scope so the error patterns aren't available beyond the catch.
        scopes.pop();
    }

    function visitCallExpression(node: ts.CallExpression): void {
        // Most call expressions are normal.  But we must special case one kind of function:
        // TypeScript's __awaiter functions.  They are of the form `__awaiter(this, void 0, void 0, function* (){})`,

        // The first 'this' argument is passed along in case the expression awaited uses 'this'.
        // However, doing that can be very bad for us as in many cases the 'this' just refers to the
        // surrounding module, and the awaited expression won't be using that 'this' at all.
        //
        // However, there are cases where 'this' may be legitimately lexically used in the awaited
        // expression and should be captured properly.  We'll figure this out by actually descending
        // explicitly into the "function*(){}" argument, asking it to be treated as if it was
        // actually a lambda and not a JS function (with the standard js 'this' semantics).  By
        // doing this, if 'this' is used inside the function* we'll act as if it's a real lexical
        // capture so that we pass 'this' along.
        walk(node.expression);

        if (isAwaiterCall(node)) {
            return visitBaseFunction(
                <ts.FunctionLikeDeclarationBase><ts.FunctionExpression>node.arguments[3],
                /*isArrowFunction*/ true,
                /*name*/ undefined);
        }

        // For normal calls, just walk all arguments normally.
        for (const arg of node.arguments) {
            walk(arg);
        }
    }

    function visitMethodDeclaration(node: ts.MethodDeclaration): void {
        if (ts.isComputedPropertyName(node.name)) {
            // Don't walk down the 'name' part of the property assignment if it is an identifier. It
            // does not capture any variables.  However, if it is a computed property name, walk it
            // as it may capture variables.
            walk(node.name);
        }

        // Always walk the method.  Pass 'undefined' for the name as a method's name is not in scope
        // inside itself.
        visitBaseFunction(node, /*isArrowFunction:*/ false, /*name:*/ undefined);
    }

    function visitPropertyAssignment(node: ts.PropertyAssignment): void {
        if (ts.isComputedPropertyName(node.name)) {
            // Don't walk down the 'name' part of the property assignment if it is an identifier. It
            // is not capturing any variables.  However, if it is a computed property name, walk it
            // as it may capture variables.
            walk(node.name);
        }

        // Always walk the property initializer.
        walk(node.initializer);
    }

    function visitPropertyAccessExpression(node: ts.PropertyAccessExpression): void {
        // Don't walk down the 'name' part of the property access.  It could not capture a free variable.
        // i.e. if you have "A.B", we should analyze the "A" part and not the "B" part.
        walk(node.expression);
    }

    function nameWalk(n: ts.BindingName | undefined, isVar: boolean): void {
        if (!n) {
            return;
        }

        switch (n.kind) {
            case ts.SyntaxKind.Identifier:
                return visitVariableDeclarationIdentifier(<ts.Identifier>n, isVar);
            case ts.SyntaxKind.ObjectBindingPattern:
            case ts.SyntaxKind.ArrayBindingPattern:
                const bindingPattern = <ts.BindingPattern>n;
                for (const element of bindingPattern.elements) {
                    if (ts.isBindingElement(element)) {
                        visitBindingElement(element, isVar);
                    }
                }

                return;
            default:
                return;
        }
    }

    function visitVariableDeclaration(node: ts.VariableDeclaration): void {
        // tslint:disable-next-line:max-line-length
        const isLet = node.parent !== undefined && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Let) !== 0;
        // tslint:disable-next-line:max-line-length
        const isConst = node.parent !== undefined && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
        const isVar = !isLet && !isConst;

        // Walk the declaration's `name` property (which may be an Identifier or Pattern) placing
        // any variables we encounter into the right scope.
        nameWalk(node.name, isVar);

        // Also walk into the variable initializer with the original walker to make sure we see any
        // captures on the right hand side.
        walk(node.initializer);
    }

    function visitVariableDeclarationIdentifier(node: ts.Identifier, isVar: boolean): void {
        // If the declaration is an identifier, it isn't a free variable, for whatever scope it
        // pertains to (function-wide for var and scope-wide for let/const).  Track it so we can
        // remove any subseqeunt references to that variable, so we know it isn't free.
        if (isVar) {
            functionVars.add(node.text);
        } else {
            currentScope().add(node.text);
        }
    }

    function visitBindingElement(node: ts.BindingElement, isVar: boolean): void {
        // array and object patterns can be quite complex.  You can have:
        //
        //  var {t} = val;          // lookup a property in 'val' called 't' and place into a variable 't'.
        //  var {t: m} = val;       // lookup a property in 'val' called 't' and place into a variable 'm'.
        //  var {t: <pat>} = val;   // lookup a property in 'val' called 't' and decompose further into the pattern.
        //
        // And, for all of the above, you can have:
        //
        //  var {t = def} = val;
        //  var {t: m = def} = val;
        //  var {t: <pat> = def} = val;
        //
        // These are the same as the above, except that if there is no property 't' in 'val',
        // then the default value will be used.
        //
        // You can also have at the end of the literal: { ...rest}

        // Walk the name portion, looking for names to add.  for
        //
        //       var {t}   // this will be 't'.
        //
        // for
        //
        //      var {t: m} // this will be 'm'
        //
        // and for
        //
        //      var {t: <pat>} // this will recurse into the pattern.
        //
        // and for
        //
        //      ...rest // this will be 'rest'
        nameWalk(node.name, isVar);

        // if there is a default value, walk it as well, looking for captures.
        walk(node.initializer);

        // importantly, we do not walk into node.propertyName
        // This Name defines what property will be retrieved from the value being pattern
        // matched against.  Importantly, it does not define a new name put into scope,
        // nor does it reference a variable in scope.
    }
}

function isAwaiterCall(node: ts.CallExpression) {
    const result =
        ts.isIdentifier(node.expression) &&
        node.expression.text === "__awaiter" &&
        node.arguments.length === 4 &&
        node.arguments[0].kind === ts.SyntaxKind.ThisKeyword &&
        ts.isFunctionLike(node.arguments[3]);

    return result;
}