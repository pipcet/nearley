(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.nearley = factory();
    }
}(this, function() {

    function Rule(name, symbols, postprocess) {
        this.id = ++Rule.highestId;
        this.name = name;
        this.symbols = symbols;        // a list of literal | regex class | nonterminal
        this.postprocess = postprocess;
        return this;
    }
    Rule.highestId = 0;

    Rule.prototype.toString = function(withCursorAt) {
        function stringifySymbolSequence (e) {
            return e.literal ? JSON.stringify(e.literal) :
                   e.type ? '%' + e.type : e.toString();
        }
        var symbolSequence = (typeof withCursorAt === "undefined")
                             ? this.symbols.map(stringifySymbolSequence).join(' ')
                             : (   this.symbols.slice(0, withCursorAt).map(stringifySymbolSequence).join(' ')
                                 + " ● "
                                 + this.symbols.slice(withCursorAt).map(stringifySymbolSequence).join(' ')     );
        return this.name + " → " + symbolSequence;
    }

    function WantedBy()
    {
        this.wants = new Set();
        this.states = new Set();
    }

    WantedBy.prototype.addState = function* (state)
    {
        this.states.add(state);
        for (let want of this.wants) {
            yield want.complete(state);
        }
    };

    WantedBy.prototype.addWant = function* (want)
    {
        let ret = this.wants.size === 0;
        this.wants.add(want);
        for (let state of this.states) {
            yield want.complete(state);
        }
        return ret;
    };

    // a State is a rule at a position from a given starting point in the input stream (reference)
    function State(rule, dot, reference, wantedBy, position) {
        this.rule = rule;
        this.dot = dot;
        this.reference = reference;
        this.data = [];
        this.wantedBy = wantedBy;
        this.isComplete = this.dot === rule.symbols.length;
        this.position = position;
    }

    State.prototype.toString = function() {
        return "{" + this.rule.toString(this.dot) + "}, from: " + (this.reference || 0);
    };

    State.prototype.nextState = function(child, position) {
        var state = new State(this.rule, this.dot + 1, this.reference, this.wantedBy, position);
        state.left = this;
        state.right = child;
        if (state.isComplete) {
            state.data = state.build();
        }
        return state;
    };

    State.prototype.build = function() {
        var children = [];
        var node = this;
        do {
            children.push(node.right.data);
            node = node.left;
        } while (node.left);
        children.reverse();
        return children;
    };

    State.prototype.finish = function() {
        if (this.rule.postprocess) {
            this.data = this.rule.postprocess(this.data, this.reference, Parser.fail);
        }
        this.finished = true;
    };

    function ProcessComplete(state, exp) {
        this.state = state;
        this.exp = exp;
    }
    ProcessComplete.prototype.toString = function ()
    {
        return "PC " + this.state;
    }

    function ProcessScannable(state) {
        this.state = state;
    }
    ProcessScannable.prototype.toString = function ()
    {
        return "PSc " + this.state;
    }

    function ProcessWants(state, exp) {
        this.state = state;
        this.exp = exp;
    }
    ProcessWants.prototype.toString = function ()
    {
        return "PW " + this.state;
    }

    function Column(grammar, index) {
        this.grammar = grammar;
        this.index = index;
        this.wants = {}; // states indexed by the non-terminal they expect
        this.completed = {}; // states that are nullable
    }

    State.prototype.processComplete = function* () {
        this.finish();
        if (this.data !== Parser.fail) {
            // complete
            var wantedBy = this.wantedBy;
            yield* wantedBy.addState(this);

            if (this.reference === this.position) {
                //yield new ProcessComplete(this, this.rule.name);
            }
        }
    };

    State.prototype.processIncomplete = function* () {
        // queue scannable states
        var exp = this.rule.symbols[this.dot];
        if (typeof exp !== 'string') {
            yield new ProcessScannable(this);
            return;
        }

        yield new ProcessWants(this, exp);
    }

    Column.prototype.processState = function*(state) {
        if (state.isComplete) {
            yield* state.processComplete();
        } else {
            yield* state.processIncomplete();
        }
    }

    Column.prototype.predict = function*(exp) {
        var rules = this.grammar.byName[exp] || [];

        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            var wantedBy = this.wants[exp];
            var s = new State(r, 0, this.index, wantedBy, this.index);
            yield s;
        }
    }

    State.prototype.complete = function (right)
    {
        return this.nextState(right, this.position + right.position - right.reference);
    }


    function Grammar(rules, start) {
        this.rules = rules;
        this.start = start || this.rules[0].name;
        var byName = this.byName = {};
        this.rules.forEach(function(rule) {
            if (!byName.hasOwnProperty(rule.name)) {
                byName[rule.name] = [];
            }
            byName[rule.name].push(rule);
        });
    }

    // So we can allow passing (rules, start) directly to Parser for backwards compatibility
    Grammar.fromCompiled = function(rules, start) {
        var lexer = rules.Lexer;
        if (rules.ParserStart) {
          start = rules.ParserStart;
          rules = rules.ParserRules;
        }
        var rules = rules.map(function (r) { return (new Rule(r.name, r.symbols, r.postprocess)); });
        var g = new Grammar(rules, start);
        g.lexer = lexer; // nb. storing lexer on Grammar is iffy, but unavoidable
        return g;
    }


    function StreamLexer() {
      this.reset("");
    }

    StreamLexer.prototype.reset = function(data, state) {
        this.buffer = data;
        this.index = 0;
        this.line = state ? state.line : 1;
        this.lastLineBreak = state ? -state.col : 0;
    }

    StreamLexer.prototype.next = function() {
        if (this.index < this.buffer.length) {
            var ch = this.buffer[this.index++];
            if (ch === '\n') {
              this.line += 1;
              this.lastLineBreak = this.index;
            }
            return {value: ch};
        }
    }

    StreamLexer.prototype.formatError = function(token, message) {
        // nb. this gets called after consuming the offending token,
        // so the culprit is index-1
        var buffer = this.buffer;
        if (typeof buffer === 'string') {
            var nextLineBreak = buffer.indexOf('\n', this.index);
            if (nextLineBreak === -1) nextLineBreak = buffer.length;
            var line = buffer.substring(this.lastLineBreak, nextLineBreak)
            var col = this.index - this.lastLineBreak;
            message += " at line " + this.line + " col " + col + ":\n\n";
            message += "  " + line + "\n"
            message += "  " + Array(col).join(" ") + "^"
            return message;
        } else {
            return message + " at index " + (this.index - 1);
        }
    }


    function Parser(rules, start, options) {
        if (rules instanceof Grammar) {
            var grammar = rules;
            var options = start;
        } else {
            var grammar = Grammar.fromCompiled(rules, start);
        }
        this.grammar = grammar;

        // Read options
        this.options = {
            keepHistory: false,
            lexer: grammar.lexer || new StreamLexer,
        };
        for (var key in (options || {})) {
            this.options[key] = options[key];
        }

        // Setup lexer
        this.lexer = this.options.lexer;
        this.lexerState = undefined;

        // Setup a table
        var column = new Column(grammar, 0);
        var table = this.table = [column];

        // I could be expecting anything.
        column.wants[grammar.start] = new WantedBy();
        // TODO what if start rule is nullable?
        this.current = 0; // token index
    }

    // create a reserved token for indicating a parse fail
    Parser.fail = {};

    Parser.prototype.lex = function(chunk) {
        let ret = [];
        var lexer = this.lexer;
        lexer.reset(chunk, this.lexerState);

        var token;
        while (token = lexer.next()) {
            ret.push(token);
        }

        return ret;
    };

    Column.prototype.handleCompleted = function*(state, exp)
    {
        if (!this.wants[exp])
            this.wants[exp] = new WantedBy();

        yield* this.wants[exp].addState(state);
    };

    Column.prototype.handleWants = function*(state, exp)
    {
        if (!this.wants[exp])
            this.wants[exp] = new WantedBy();

        if (yield* this.wants[exp].addWant(state)) {
            for (let state of this.predict(exp)) {
                yield state;
            }
        }
    };

    Column.prototype.handleScannable = function*(state, value, literal, token, n)
    {
        let expect = state.rule.symbols[state.dot];

        if (expect.test ? expect.test(value) :
            expect.type ? expect.type === token.type
            : expect.literal === literal) {
            yield state.nextState({data: value, token: token, isToken: true, reference: n - 1}, this.index+1);
        }
    };

    Parser.prototype.dialog = function*(g) {
        let state;
        this.table[0] = (new Column(this.grammar, 0));
        this.table[0].wants[this.grammar.start] = new WantedBy();
        for (let state of this.table[0].predict(this.grammar.start)) {
            yield state;
        }
        while (state = yield) {
            while (!this.table[state.position]) {
                this.table.push(new Column(this.grammar, this.table.length));
            }
            let column = this.table[state.position];

            for (let p of column.processState(state)) {
                if (p instanceof ProcessComplete) {
                    yield* column.handleCompleted(p.state, p.exp);
                } else if (p instanceof ProcessWants) {
                    yield* column.handleWants(p.state, p.exp);
                } else if (p instanceof ProcessScannable) {
                    let token = g[column.index];
                    if (token === undefined) {
                        continue;
                    }
                    var literal = token.text !== undefined ? token.text : token.value;
                    var value = this.lexer.constructor === StreamLexer ? token.value : token;
                    yield* column.handleScannable(p.state, value, literal, token, column.index);
                } else if (p instanceof State) {
                    yield p;
                }
            }
        }
    };

    Parser.prototype.feed = function (chunk)
    {
        if (this.fed === undefined)
            this.fed = "";
        this.fed += chunk;
    };

    Parser.prototype.socrates = function* (g) {
        if (this.fed !== undefined) {
            g = g.concat(this.lex(this.fed));
        }
        let d = this.dialog(g);
        let p, qs = [], r;
        let iter = 0;
        let succ = 0;
        let maxv;
        while (p = d.next(r)) {
            r = undefined;
            if (p.done)
                break;

            let v = p.value;

            if (v === undefined) {
                while (qs.length && qs[qs.length-1].length === 0)
                    qs.pop();
                if (qs.length) {
                    r = qs[qs.length-1].shift();
                }
                iter++;
                //if (r)
                //    console.log("@"+r.position+"/" + g.length + " " + q.length + " in: " + r);
            } else {
                //console.log("@"+v.position+"/" + g.length + " out: " + v);
                if (!maxv || v.position > maxv.position) {
                    maxv = v;
                }
                if (v.position == g.length && v.isComplete && v.rule.name == this.grammar.start) {
                    v.finish();
                    yield v.data;
                    succ++;
                } else {
                    let index = v.position;
                    while (!qs[index])
                        qs.push([]);
                    qs[index].push(v);
                }
            }
        }
        if (succ === 0) {
            // No states at all! This is not good.
            let token = g[maxv.position || 0];
            if (!token)
                return;
            var message = this.lexer.formatError(token, "invalid syntax") + "\n";
            message += "Unexpected " + (token.type ? token.type + " token: " : "");
            message += JSON.stringify(token.value !== undefined ? token.value : token) + "\n";
            var err = new Error(message);
            err.offset = maxv.position;
            err.token = g[err.offset];
            throw err;
        }
    };

    Parser.prototype.parse = function*(g) {
        let pg = this.parsegen();
        let p, r;
        while (p = pg.next(r)) {
            if (p.done)
                break;
            if (p.value === undefined) {
                r = g.shift();
                continue;
            }
            yield p.value;
        }
    };

    return {
        Parser: Parser,
        Grammar: Grammar,
        Rule: Rule,
    };

}));
