var tp = {};

tp.mods = {};
tp.mods.cp = require('child_process');
tp.mods.eachline = require('eachline');
tp.mods.jison = require('jison');
tp.mods.dom = require('xmldom');
tp.mods.tmp = require('tmp');
tp.mods.fs = require('fs');
tp.mods.path = require('path');
tp.mods.nomnom = require('nomnom');


tp.procs = {};

tp.pdf = {};
tp.pdf.grammar = {
    "lex": {
        "rules": [
            ["\\s+", "/* skip whitespace */"],
            ["<<", "return 'OBJSTART';"],
            [">>", "return 'OBJEND';"],
            ["\\[", "return 'ARRSTART';"],
            ["\\]", "return 'ARREND';"],
	    ["/[A-Z][A-Za-z0-9]*", "return 'KEY';"],
	    ["/pdftk_[A-Z][A-Za-z0-9]*", "return 'KEY';"],
	    ["\\d+\\s+\\d\\s+R", "return 'OBJREF';"],
	    ["\\(.*?\\)", "return 'LITSTR';"],
	    ["stream.*?endstream", "return 'STREAM';"],
	    [/true/i, "return 'BOOL';"],
	    [/false/i, "return 'BOOL';"],
	    ["\\d+(\\.\\d+)?", "return 'LITNUM';"],
        ]
    },

    "bnf": {
	"root" :[ ["pdfobj", "return $$;"], ],
        "pdfobj" :[ ["OBJSTART OBJEND", "$$={};"],
		    ["OBJSTART keyvals OBJEND", "$$=$2;"],
		    ["OBJSTART keyvals OBJEND STREAM", "$$=$2; $$.stream=$4.slice(7,-10);"] ],
	"keyvals" :[ ["KEY val", "$$={}; $$[$1] = $2;" ],
		     ["KEY val keyvals", "$$={}; $$[$1] = $2; for (key in $3) { $$[key] = $3[key]; }" ], ],
	"val" :[ ["ARRSTART vals ARREND", "$$=$2;" ],
		 ["pdfobj", "$$=$1;" ],
		 ["BOOL", "$$=$1;" ],
		 ["LITNUM", "$$=Number(yytext);" ],
		 ["KEY", "$$=$1;" ],
		 ["OBJREF", "$$=$1;" ],
		 ["LITSTR", "$$=$1;" ], ],
	"vals" :[ ["val", "$$=[$1];" ],
		  ["val vals", "$$=[$1].concat($2);" ], ],
    }
};

tp.pdf.parser = new tp.mods.jison.Parser(tp.pdf.grammar);

tp.data = {};

tp.jsondb = {
    data: {},
    put: function(key, value) {
	this.data[key] = value;
    },
    get: function(key) {
	return this.data[key];
    }
};

tp.fsdb = {
    tmpdir: tp.mods.tmp.dirSync({prefix:"tagpdf_",keep:false,unsafeCleanup: true}),
    put: function(key, value) {
	//tp.data[key] = value;
	console.error("PUT %j", {tmpdir:this.tmpdir, key: key});
	tp.mods.fs.writeFileSync(tp.mods.path.resolve(this.tmpdir.name, key),
				 JSON.stringify(value));
    },
    get: function(key) {
	return JSON.parse(tp.mods.fs.readFileSync(tp.mods.path.resolve(this.tmpdir.name, key)));
    }
};

tp.db = tp.fsdb;

tp.jsonifyPDFObject = function(objkey) {
    var objlines = tp.db.get(objkey);
    console.error("OBJLINES: %j", objlines);
    var obj = tp.pdf.parser.parse(objlines.join(" "));
    console.error("OBJ: %j", obj);
    return obj;
};

tp.jsonifyStructureObject = function(objkey) {
    console.error("HERE: %s", objkey);
    var obj = tp.jsonifyPDFObject(objkey);
    console.error("THERE: %j", obj);

    if (obj["/K"]) {
	var kidkeys = obj["/K"].filter(function(kid) {
	    return ((typeof kid) === 'string');
	}).map(function(kid) {
	    return kid.split(/\s+/).slice(0,-1).join(" ");
	});

	console.error("KIDKEYS: %j", kidkeys);
	
	obj.children = kidkeys.map(tp.jsonifyStructureObject); // recursive!
    }
    
    return obj;
};

tp.jsonifyPagesObject = function(objkey) {
    console.error("HERE: %s", objkey);
    var obj = tp.jsonifyPDFObject(objkey);
    console.error("THERE: %j", obj);

    if (obj["/Kids"]) {
	var kidkeys = obj["/Kids"].filter(function(kid) {
	    return ((typeof kid) === 'string');
	}).map(function(kid) {
	    return kid.split(/\s+/).slice(0,-1).join(" ");
	});

	console.error("KIDKEYS: %j", kidkeys);
	
	obj.children = kidkeys.map(tp.jsonifyPagesObject); // recursive!
    }
    
    return obj;
};

tp.crawlMetadata = function(element, target) {
    if (element.localName === 'title') {
	target.title = element.textContent;
    }
    if (element.localName === 'creator') {
	target.creator = element.textContent;
    }
    
    if (element.firstChild) {
	tp.crawlMetadata(element.firstChild, target);
    }
    if (element.nextSibling) {
	tp.crawlMetadata(element.nextSibling, target);
    }
};

process.on('tagpdf2json', function(spec) {
    tp.procs.pdftk = tp.mods.cp.spawn('bash', ['-c',
					       [['pdftk "', spec.filename, '" output - uncompress'].join(''),
					       'tee /tmp/tagpdf.pdf',
					       'tail -n +3'
					       ].join(" | ")]);

    tp.regex = {};
    tp.regex.objstart = /^(\d+\s+\d+)\s+obj/;
    tp.regex.objterm = /^endobj/;
    tp.regex.catalog = /^\/Type\s+\/Catalog/;
    tp.procs.filt = new tp.mods.eachline(function(line) {
	var match = tp.regex.objstart.exec(line);
	if (match != null) {
	    var key = match[1];
	    //console.error("START OBJ: " + key);
	    tp.data.currentKey = key;
	    tp.data.current = [];
	    return;
	}
	if (tp.regex.objterm.exec(line)) {
	    tp.db.put(tp.data.currentKey, tp.data.current);
	    delete tp.data.currentKey;
	    delete tp.data.current;
	    return;
	}
	if (tp.regex.catalog.exec(line)) {
	    tp.data.catalogKey = tp.data.currentKey;
	}
	
	if (tp.data.current) {
	    tp.data.current.push(line);
	}
	//console.error("LINE %s", line);
    });

    tp.procs.filt.on('end', function() {
	var catalog = tp.jsonifyPDFObject(tp.data.catalogKey);

	if (catalog["/StructTreeRoot"]) {	
	    var treeRootKey = catalog["/StructTreeRoot"].slice(0,-2);
	    var treeRoot = tp.jsonifyStructureObject(treeRootKey);

	    catalog.structTree = treeRoot;
	}
	if (catalog["/Pages"]) {	
	    var pagesKey = catalog["/Pages"].slice(0,-2);
	    catalog.pages = tp.jsonifyPagesObject(pagesKey);
	}
	if (catalog["/Metadata"]) {	
	    var metaKey = catalog["/Metadata"].slice(0,-2);
	    catalog.metadata = tp.jsonifyPDFObject(metaKey);

	    if (catalog.metadata && catalog.metadata.stream) {
		var dom = new tp.mods.dom.DOMParser().parseFromString(catalog.metadata.stream);
		console.error("XML: " + new tp.mods.dom.XMLSerializer().serializeToString(dom));

		if (dom.documentElement) {
		    catalog.metadata.content = {};
		    tp.crawlMetadata(dom.documentElement, catalog.metadata.content);
		}
	    }
	}
	
	console.log(JSON.stringify(catalog, null, 2));
    });
    
    tp.procs.pdftk.stdout.pipe(tp.procs.filt);
    tp.procs.filt.pipe(process.stdout);
});

tp.optparser = tp.mods.nomnom();
tp.optparser.option("input", {
    abbr: "i",
    default: [],
    list: true,
});
tp.optparser.option("output", {
    abbr: "o",
    default: [],
    list: true,
});

tp.opts = tp.optparser.parse();
tp.opts.input = tp.opts.input.concat(tp.opts['_']);

console.error("OPTS: %j", tp.opts);	   

process.emit('tagpdf2json', tp.opts);
