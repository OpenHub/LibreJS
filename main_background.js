/**
* GNU LibreJS - A browser add-on to block nonfree nontrivial JavaScript.
* *
* Copyright (C) 2017, 2018 Nathan Nichols
* Copyright (C) 2018 Ruben Rodriguez <ruben@gnu.org>
*
* This file is part of GNU LibreJS.
*
* GNU LibreJS is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* GNU LibreJS is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with GNU LibreJS.  If not, see <http://www.gnu.org/licenses/>.
*/

var acorn_base = require("acorn");
var acorn = require('acorn/dist/acorn_loose');
var jssha = require('jssha');
var walk = require("acorn/dist/walk");
var legacy_license_lib = require("./legacy_license_check.js");
var {ResponseProcessor} = require("./bg/ResponseProcessor");
var {Storage, ListStore} = require("./bg/Storage");
var {ListManager} = require("./bg/ListManager");

console.log("main_background.js");
/**
*	If this is true, it evaluates entire scripts instead of returning as soon as it encounters a violation.
*
*	Also, it controls whether or not this part of the code logs to the console.
*
*/
var DEBUG = false; // debug the JS evaluation 
var PRINT_DEBUG = false; // Everything else 
var time = Date.now();

function dbg_print(a,b){
	if(PRINT_DEBUG == true){
		console.log("Time spent so far: " + (Date.now() - time)/1000 + " seconds");
		if(b === undefined){
			console.log(a);
		} else{
			console.log(a,b);
		}
	}
}

/**
*	Wrapper around crypto lib
*
*/
function hash(source){
	var shaObj = new jssha("SHA-256","TEXT")
	shaObj.update(source);
	return shaObj.getHash("HEX");
}


// the list of all available event attributes
var intrinsic_events = [
    "onload",
    "onunload",
    "onclick",
    "ondblclick",
    "onmousedown",
    "onmouseup",
    "onmouseovr",
    "onmousemove",
    "onmouseout",
    "onfocus",
    "onblur",
    "onkeypress",
    "onkeydown",
    "onkeyup",
    "onsubmit",
    "onreset",
    "onselect",
    "onchange"
];

/*
	NONTRIVIAL THINGS:
	- Fetch
	- XMLhttpRequest
	- eval()
	- ?
	JAVASCRIPT CAN BE FOUND IN:
	- Event handlers (onclick, onload, onsubmit, etc.)
	- <script>JS</script>
	- <script src="/JS.js"></script>
	WAYS TO DETERMINE PASS/FAIL:
	- "// @license [magnet link] [identifier]" then "// @license-end" (may also use /* comments)
	- Automatic whitelist: (http://bzr.savannah.gnu.org/lh/librejs/dev/annotate/head:/data/script_libraries/script-libraries.json_
*/
var licenses = require("./licenses.json").licenses;

// These are objects that it will search for in an initial regex pass over non-free scripts.
var reserved_objects = [
	//"document",
	//"window",
	"fetch",
	"XMLHttpRequest",
	"chrome", // only on chrome
	"browser", // only on firefox
	"eval"
];

/**
*	
*	Sets global variable "webex" to either "chrome" or "browser" for
*	use on Chrome or a Firefox variant.
*
*	Change this to support a new browser that isn't Chrome or Firefox,
*	given that it supports webExtensions.
*
*	(Use the variable "webex" for all API calls after calling this)
*/
var webex;
function set_webex(){
	if(typeof(browser) == "object"){
		webex = browser;
	}
	if(typeof(chrome) == "object"){
		webex = chrome;
	}
}

// Generates JSON key for local storage
function get_storage_key(script_name,src_hash){
	return script_name;
}

/*
*
*	Called when something changes the persistent data of the add-on.
*
*	The only things that should need to change this data are:
*	a) The "Whitelist this page" button
*	b) The options screen
*
*	When the actual blocking is implemented, this will need to comminicate
*	with its code to update accordingly
*
*/
function options_listener(changes, area){
	// The cache must be flushed when settings are changed
	// TODO: See if this can be minimized
	function flushed(){
		dbg_print("cache flushed");
	}	
	//var flushingCache = webex.webRequest.handlerBehaviorChanged(flushed);
	

	dbg_print("Items updated in area" + area +": ");

	var changedItems = Object.keys(changes);
	var changed_items = "";
	for (var i = 0; i < changedItems.length; i++){
		var item = changedItems[i];		
		changed_items += item + ",";
	}
	dbg_print(changed_items);

}


var active_connections = {};
var unused_data = {};
function createReport(initializer = null) {
	let template =  {
		"accepted": [],
		"blocked": [],
		"blacklisted": [],
		"whitelisted": [],
		"unknown": [],
		url: "",
	};
	if (initializer) {
		template = Object.assign(template, initializer);
	}
	template.site = ListStore.siteItem(template.url);
	template.siteStatus = listManager.getStatus(template.site);
	return template;
}

/**
*	Executes the "Display this report in new tab" function
*	by opening a new tab with whatever HTML is in the popup
*	at the moment.
*/
async function openReportInTab(data) {
	let popupURL = await browser.browserAction.getPopup({});
	let tab = await browser.tabs.create({url: `${popupURL}#fromTab=${data.tabId}`});
	unused_data[tab.id] = createReport(data);
}

/**
*
*	Clears local storage (the persistent data)
*
*/
function debug_delete_local(){
	webex.storage.local.clear();
	dbg_print("Local storage cleared");
}

/**
*
*	Prints local storage (the persistent data) as well as the temporary popup object
*
*/
function debug_print_local(){
	function storage_got(items){
		console.log("%c Local storage: ", 'color: red;');
		for(var i in items){
			console.log("%c "+i+" = "+items[i], 'color: blue;');
		}
	}
	console.log("%c Variable 'unused_data': ", 'color: red;');
	console.log(unused_data);
	webex.storage.local.get(storage_got);
}

/**
*
*
*	Sends a message to the content script that sets the popup entries for a tab.
*
*	var example_blocked_info = {
*		"accepted": [["REASON 1","SOURCE 1"],["REASON 2","SOURCE 2"]],
*		"blocked": [["REASON 1","SOURCE 1"],["REASON 2","SOURCE 2"]],
*		"url": "example.com"
*	}
*
*	NOTE: This WILL break if you provide inconsistent URLs to it.
*	Make sure it will use the right URL when refering to a certain script.
* 
*/
function updateReport(tabId, oldReport, updateUI = false){
	let {url} = oldReport;
	let newReport = createReport({url, tabId});
	for (let property of Object.keys(oldReport)) {
		let entries = oldReport[property];
		if (!Array.isArray(entries)) continue;
		let defValue = property === "accepted" || property === "blocked" ? property : "unknown";
		for (let script of entries) {
			let status = listManager.getStatus(script[0],  defValue);
			if (Array.isArray(newReport[status])) newReport[status].push(script);
		}
	}
	unused_data[tabId] = newReport;
	dbg_print(newReport);
	if (updateUI && active_connections[tabId]) {
		dbg_print(`[TABID: ${tabId}] Sending script blocking report directly to browser action.`);
		active_connections[tabId].postMessage({show_info: newReport});
	}
}

/**
*
*	This is what you call when a page gets changed to update the info box.
*
*	Sends a message to the content script that adds a popup entry for a tab.
*
*	The action argument is an object with two properties: one named either 
* "accepted","blocked", "whitelisted", "blacklisted" or "unknown", whose value 
* is the array [scriptName, reason], and another named "url". Example:
* action = {
*		"accepted": ["jquery.js (someHash)","Whitelisted by user"],
*		"url": "https://example.com/js/jquery.js"
*	}
*
*	Returns either "whitelisted, "blacklisted", "blocked", "accepted" or "unknown"
*
*	NOTE: This WILL break if you provide inconsistent URLs to it.
*	Make sure it will use the right URL when refering to a certain script.
*
*/
async function addReportEntry(tabId, scriptHashOrUrl, action, update = false) {
	if(!unused_data[tabId]) {
		unused_data[tabId] = createReport({url: (await browser.tabs.get(tabId)).url});
	}
	let type, actionValue;
	for (type of ["accepted", "blocked", "whitelisted", "blacklisted"]) {
		if (type in action) {
			actionValue = action[type];
			break;
		}
	}
	if (!actionValue) {
		console.debug("Something wrong with action", action);
		return "";
	}

	// Search unused data for the given entry
	function isNew(entries, item) {
		for (let e of entries) {
			if (e[0] === item) return false;
		}
		return true;
	}

	let entryType;
	let scriptName = actionValue[0];
	try {
		entryType = listManager.getStatus(scriptName, type);
		let entries = unused_data[tabId][entryType];
		if(isNew(entries, scriptName)){
			dbg_print(unused_data);
			dbg_print(unused_data[tabId]);
			dbg_print(entryType);
			entries.push(actionValue);
		}
	} catch (e) {
		console.error("action %o, type %s, entryType %s", action, type, entryType, e);
		entryType = "unknown";
	}
	
	if (active_connections[tabId]) {
		try {
			active_connections[tabId].postMessage({show_info: unused_data[tabId]});
		} catch(e) {
		}
	}
	
	return entryType;
}


function get_domain(url){
	var domain = url.replace('http://','').replace('https://','').split(/[/?#]/)[0];
	if(url.indexOf("http://") == 0){
		domain = "http://" + domain;
	}
	else if(url.indexOf("https://") == 0){
		domain = "https://" + domain;
	}
	domain = domain + "/";
	domain = domain.replace(/ /g,"");
	return domain;
}

/**
*
*	This is the callback where the content scripts of the browser action will contact the background script.
*
*/
var portFromCS;
function connected(p) {
	if(p["name"] == "contact_finder"){
		// Send a message back with the relevant settings
		function cb(items){
			p.postMessage(items);
		}
		webex.storage.local.get(cb);
		return;		
	}
	p.onMessage.addListener(async function(m) {
		var update = false;
		var contact_finder = false;
		
		for (let action of ["whitelist", "blacklist", "forget"]) {
			if (m[action]) {
				let [key] = m[action];
				if (m.site) key = ListStore.siteItem(key); 
				await listManager[action](key);
				update = true;
			}
		}
		
		if(m.report_tab){
			openReportInTab(m.report_tab);
		}
		// a debug feature
		if(m["printlocalstorage"] !== undefined){
			console.log("Print local storage");
			debug_print_local();
		}
		// invoke_contact_finder
		if(m["invoke_contact_finder"] !== undefined){
			contact_finder = true;
			inject_contact_finder();
		}
		// a debug feature (maybe give the user an option to do this?)
		if(m["deletelocalstorage"] !== undefined){
			console.log("Delete local storage");
			debug_delete_local();
		}
	
		let tabs = await browser.tabs.query({active: true, currentWindow: true});
		
		if(contact_finder){
			let tab = tabs.pop();
			dbg_print(`[TABID:${tab.id}] Injecting contact finder`);
			//inject_contact_finder(tabs[0]["id"]);
		}
		if (update || m.update && unused_data[m.tabId]) {
			let tabId = "tabId" in m ?  m.tabId : tabs.pop().id;
			dbg_print(`%c updating tab ${tabId}`, "color: red;");
			active_connections[tabId] = p;
			await updateReport(tabId, unused_data[tabId], true);
		} else {
			for(let tab of tabs) {
				if(unused_data[tab.id]){
					// If we have some data stored here for this tabID, send it
					dbg_print(`[TABID: ${tab.id}] Sending stored data associated with browser action'`);								
					p.postMessage({"show_info": unused_data[tab.id]});
				} else{
					// create a new entry
					let report = unused_data[tab.id] = createReport({"url": tab.url, tabId: tab.id});
					p.postMessage({show_info: report});							
					dbg_print(`[TABID: ${tab.id}] No data found, creating a new entry for this window.`);	
				}
			}
		}
	});
}

/**
*	The callback for tab closings.
*
*	Delete the info we are storing about this tab if there is any.
*
*/
function delete_removed_tab_info(tab_id, remove_info){
	dbg_print("[TABID:"+tab_id+"]"+"Deleting stored info about closed tab");
	if(unused_data[tab_id] !== undefined){
		delete unused_data[tab_id];
	}
	if(active_connections[tab_id] !== undefined){
		delete active_connections[tab_id];
	}
}

/* *********************************************************************************************** */

var fname_data = require("./fname_data.json").fname_data;

//************************this part can be tested in the HTML file index.html's script test.js****************************

function full_evaluate(script){
		var res = true;		
		if(script === undefined || script == ""){
			return [true,"Harmless null script"];		
		}

		var ast = acorn.parse_dammit(script).body[0];

		var flag = false;
		var amtloops = 0;

		var loopkeys = {"for":true,"if":true,"while":true,"switch":true};
		var operators = {"||":true,"&&":true,"=":true,"==":true,"++":true,"--":true,"+=":true,"-=":true,"*":true};
		try{
			var tokens = acorn_base.tokenizer(script);	
		}catch(e){
			console.warn("Tokenizer could not be initiated (probably invalid code)");
			return [false,"Tokenizer could not be initiated (probably invalid code)"];		
		}
		try{
			var toke = tokens.getToken();
		}catch(e){
			console.log(script);
			console.log(e);
			console.warn("couldn't get first token (probably invalid code)");
			console.warn("Continuing evaluation");
		}

		/**
		* Given the end of an identifer token, it tests for bracket suffix notation
		*/
		function being_called(end){
			var i = 0;
			while(script.charAt(end+i).match(/\s/g) !== null){
				i++;
				if(i >= script.length-1){
					return false;
				}
			}

			return script.charAt(end+i) == "(";
		}
		/**
		* Given the end of an identifer token, it tests for parentheses
		*/
		function is_bsn(end){
			var i = 0;
			while(script.charAt(end+i).match(/\s/g) !== null){
				i++;
				if(i >= script.length-1){
					return false;
				}
			}
			return script.charAt(end+i) == "[";
		}
		var error_count = 0;
		while(toke !== undefined && toke.type != acorn_base.tokTypes.eof){		
			if(toke.type.keyword !== undefined){
				//dbg_print("Keyword:");
				//dbg_print(toke);
				
				// This type of loop detection ignores functional loop alternatives and ternary operators

				if(toke.type.keyword == "function"){
					dbg_print("%c NONTRIVIAL: Function declaration.","color:red");
					if(DEBUG == false){			
						return [false,"NONTRIVIAL: Function declaration."];
					}		
				}

				if(loopkeys[toke.type.keyword] !== undefined){
					amtloops++;
					if(amtloops > 3){
						dbg_print("%c NONTRIVIAL: Too many loops/conditionals.","color:red");
						if(DEBUG == false){			
							return [false,"NONTRIVIAL: Too many loops/conditionals."];
						}		
					}
				}
			}else if(toke.value !== undefined && operators[toke.value] !== undefined){
				// It's just an operator. Javascript doesn't have operator overloading so it must be some
				// kind of primitive (I.e. a number)
			}else if(toke.value !== undefined){
				var status = fname_data[toke.value];
				if(status === true){ // is the identifier banned?				
					dbg_print("%c NONTRIVIAL: nontrivial token: '"+toke.value+"'","color:red");
					if(DEBUG == false){			
						return [false,"NONTRIVIAL: nontrivial token: '"+toke.value+"'"];
					}	
				}else if(status === false){// is the identifier not banned?
					// Is there bracket suffix notation?
					if(is_bsn(toke.end)){
						dbg_print("%c NONTRIVIAL: Bracket suffix notation on variable '"+toke.value+"'","color:red");
						if(DEBUG == false){			
							return [false,"%c NONTRIVIAL: Bracket suffix notation on variable '"+toke.value+"'"];
						}	
					}
				}else if(status === undefined){// is the identifier user defined?
					// Are arguments being passed to a user defined variable?
					if(being_called(toke.end)){
						dbg_print("%c NONTRIVIAL: User defined variable '"+toke.value+"' called as function","color:red");
						if(DEBUG == false){			
							return [false,"NONTRIVIAL: User defined variable '"+toke.value+"' called as function"];
						}	
					}
					// Is there bracket suffix notation?
					if(is_bsn(toke.end)){
						dbg_print("%c NONTRIVIAL: Bracket suffix notation on variable '"+toke.value+"'","color:red");
						if(DEBUG == false){			
							return [false,"NONTRIVIAL: Bracket suffix notation on variable '"+toke.value+"'"];
						}	
					}
				}else{
					dbg_print("trivial token:"+toke.value);
				}
			}
			// If not a keyword or an identifier it's some kind of operator, field parenthesis, brackets 
			try{
				toke = tokens.getToken();
			}catch(e){
				dbg_print("Denied script because it cannot be parsed.");
				return [false,"NONTRIVIAL: Cannot be parsed. This could mean it is a 404 error."];
			}
		}

		dbg_print("%cAppears to be trivial.","color:green;");
		return [true,"Script appears to be trivial."];
}


//****************************************************************************************************
/**
*	This is the entry point for full code evaluation.
*
*	Performs the initial pass on code to see if it needs to be completely parsed
*
*	This can only determine if a script is bad, not if it's good
*
*	If it passes the intitial pass, it runs the full pass and returns the result
*
*/
function evaluate(script,name){
	function reserved_object_regex(object){
		var arith_operators = "\\+\\-\\*\\/\\%\\=";
		var scope_chars = "\{\}\]\[\(\)\,";
		var trailing_chars = "\s*"+"\(\.\[";
		return new RegExp("(?:[^\\w\\d]|^|(?:"+arith_operators+"))"+object+'(?:\\s*?(?:[\\;\\,\\.\\(\\[])\\s*?)',"g");
	}		
	reserved_object_regex("window");
	var all_strings = new RegExp('".*?"'+"|'.*?'","gm");
	var ml_comment = /\/\*([\s\S]+?)\*\//g;
	var il_comment = /\/\/.+/gm;
	var bracket_pairs = /\[.+?\]/g;
	var temp = script.replace(/'.+?'+/gm,"'string'");
	temp = temp.replace(/".+?"+/gm,'"string"');
	temp = temp.replace(ml_comment,"");
	temp = temp.replace(il_comment,"");
	dbg_print("%c ------evaluation results for "+ name +"------","color:white");
	dbg_print("Script accesses reserved objects?");
	var flag = true;
	var reason = ""
	// 	This is where individual "passes" are made over the code
	for(var i = 0; i < reserved_objects.length; i++){
		var res = reserved_object_regex(reserved_objects[i]).exec(temp);
		if(res != null){
			dbg_print("%c fail","color:red;");
			flag = false;		
			reason = "Script uses a reserved object (" + reserved_objects[i] + ")";
		}
	}
	if(flag){
		dbg_print("%c pass","color:green;");
	} else{
		return [flag,reason];
	}

	var final = full_evaluate(script);
//	final[1] = final[1] + "<br>";
	return final;
}



function license_valid(matches){
	if(matches.length != 4){
		return [false, "malformed or unrecognized license tag"];
	}
	if(matches[1] != "@license"){
		return [false, "malformed or unrecognized license tag"];	
	}
	if(licenses[matches[3]] === undefined){
		return [false, "malformed or unrecognized license tag"];
	}
	if(licenses[matches[3]]["Magnet link"] != matches[2]){
		return [false, "malformed or unrecognized license tag"];
	}
	return [true,"Recognized license as '"+matches[3]+"'<br>"];
}
/**
*
*	Evaluates the content of a script (license, if it is non-trivial)
*
*	Returns
*	[ 
*		true (accepted) or false (denied),
*		edited content,
*		reason text		
*	]
*/
function license_read(script_src, name, external = false){
	
	var reason_text = "";

	var edited_src = "";
	var unedited_src = script_src;
	var nontrivial_status;
	var parts_denied = false;
	var parts_accepted = false;
	var license = legacy_license_lib.check(script_src);
	if(license != false){
		return [true,script_src,"Licensed under: "+license];
	}
	if (listManager.builtInHashes.has(hash(script_src))){
		return [true,script_src,"Common script known to be free software."];
	}
	while(true){ // TODO: refactor me
		// TODO: support multiline comments
		var matches = /\/[\/\*]\s*?(@license)\s([\S]+)\s([\S]+$)/gm.exec(unedited_src);
		var empty = /[^\s]/gm.exec(unedited_src);
		if(empty == null){
			return [true,edited_src,reason_text];
		}
		if(matches == null){
			if (external)
				return [false,edited_src,"External script with no known license."];
			else
				nontrivial_status = evaluate(unedited_src,name);
			if(nontrivial_status[0] == true){
				parts_accepted = true;
				edited_src += unedited_src;
			} else{
				parts_denied = true;
				edited_src += "\n/*\nLIBREJS BLOCKED:"+nontrivial_status[1]+"\n*/\n";
			}
			reason_text += "\n" + nontrivial_status[1];
			
			if(parts_denied == true && parts_accepted == true){
				reason_text = "Script was determined partly non-trivial after editing. (check source for details)\n"+reason_text;
			}
			if(parts_denied == true && parts_accepted == false){
				return [false,edited_src,reason_text];
			}
			else return [true,edited_src,reason_text];
			
		}
		// sponge
		dbg_print("undedited_src:");
		dbg_print(unedited_src);
		dbg_print(matches);
		dbg_print("chopping at " + matches["index"] + ".");
		var before = unedited_src.substring(0,matches["index"]);
		// sponge
		dbg_print("before:");
		dbg_print(before);
		if (external)
			nontrivial_status = [true, "External script with no known license"]
		else
			nontrivial_status = evaluate(before,name);
		if(nontrivial_status[0] == true){
			parts_accepted = true;
			edited_src += before;
		} else{
			parts_denied = true;
			edited_src += "\n/*\nLIBREJS BLOCKED:"+nontrivial_status[1]+"\n*/\n";
		}
		unedited_src = unedited_src.substr(matches["index"],unedited_src.length);
		// TODO: support multiline comments
		var matches_end = /\/\/\s*?(@license-end)/gm.exec(unedited_src);
		if(matches_end == null){
			dbg_print("ERROR: @license with no @license-end");
			return [false,"\n/*\n ERROR: @license with no @license-end \n*/\n","ERROR: @license with no @license-end"];
		}
		var endtag_end_index = matches_end["index"]+matches_end[0].length;
		var license_res = license_valid(matches);
		if(license_res[0] == true){
			edited_src =  edited_src + unedited_src.substr(0,endtag_end_index);
			reason_text += "\n" + license_res[1];		
		} else{
			edited_src = edited_src + "\n/*\n"+license_res[1]+"\n*/\n";
			reason_text += "\n" + license_res[1];
		}
		// trim off everything we just evaluated
		unedited_src = unedited_src.substr(endtag_end_index,unedited_src.length);
	}
}

/* *********************************************************************************************** */
// TODO: Test if this script is being loaded from another domain compared to unused_data[tabid]["url"]

/**
*	Asynchronous function, returns the final edited script as a string, 
* or an array containing it and the index, if the latter !== -1
*/
async function get_script(response, url, tabId = -1, whitelisted = false, index = -1) {
	function result(scriptSource) {
		return index === -1 ? scriptSource : [scriptSource, index];
	}
	

	let scriptName = url.split("/").pop();
	if (whitelisted) {
		if (tabId !== -1) {
			let site = ListStore.siteItem(url); 
			// Accept without reading script, it was explicitly whitelisted
			let reason = whitelist.contains(site)
				? `All ${site} whitelisted by user` 
				: "Address whitelisted by user";
			addReportEntry(tabId, url, {"whitelisted": [url, reason], url});
		}
		return result(`/* LibreJS: script whitelisted by user preference. */\n${response}`);
	}
	
	let [verdict, editedSource, reason] = license_read(response, scriptName, index === -2);
	
	if (tabId < 0) {
		return result(verdict ? response : editedSource);
	}
	
	let sourceHash = hash(response);
 	let domain = get_domain(url);
	let report = unused_data[tabId] || (unused_data[tabId] = createReport({url, tabId}));
	let blockedCount = report.blocked.length + report.blacklisted.length;
	dbg_print(`amt. blocked on page: ${blockedCount}`);
	if (blockedCount > 0 || !verdict) {
		webex.browserAction.setBadgeText({
			text: "!",
			tabId
		});
		webex.browserAction.setBadgeBackgroundColor({
			color: "red",
			tabId
		});
	}
	let category = await addReportEntry(tabId, sourceHash, {"url": domain, [verdict ? "accepted" : "blocked"]: [url, reason]});
	let scriptSource = verdict ? response : editedSource;
	switch(category) {
		case "blacklisted":
		case "whitelisted": 
			return result(`/* LibreJS: script ${category} by user. */\n${scriptSource}`);
		default:
			return result(`/* LibreJS: script ${category}. */\n${scriptSource}`);		
	}
}

/**
* 	Tests if a request is google analytics or not
*/
function test_GA(a){ // TODO: DRY me
	// This is just an HTML page
	if(a.url == 'https://www.google.com/analytics/#?modal_active=none'){
		return false;
	}
	else if(a.url.match(/https:\/\/www\.google\.com\/analytics\//g)){
		dbg_print("%c Google analytics (1)","color:red");
		return {cancel: true};
	}
	else if(a.url == 'https://www.google-analytics.com/analytics.js'){
		dbg_print("%c Google analytics (2)","color:red");
		return {cancel: true};
	}
	else if(a.url == 'https://www.google.com/analytics/js/analytics.min.js'){
		dbg_print("%c Google analytics (3)","color:red");
		return {cancel: true};
	}
	else return false;
}

/**
*	A callback that every type of request invokes.
*/
function block_ga(a){
	var GA = test_GA(a);
	if(GA != false){
		return GA;
	}
	else return {};
}



/**
*	This listener gets called as soon as we've got all the HTTP headers, can guess
* content type and encoding, and therefore correctly parse HTML documents
* and external script inclusions in search of non-free JavaScript
*/

var ResponseHandler = {
	/**
	*	Enforce white/black lists for url/site early (hashes will be handled later)
	*/
	pre(response) {
		let {request} = response;
		let {url, type, tabId} = request;
		
		url = ListStore.urlItem(url);
		let site = ListStore.siteItem(url);
		
		let blacklistedSite = blacklist.contains(site);
		let blacklisted = blacklistedSite || blacklist.contains(url);
		let topUrl = request.frameAncestors && request.frameAncestors.pop() || request.documentUrl;
		
		if (blacklisted) {
			if (type === "script") {
				// abort the request before the response gets fetched
				addReportEntry(tabId, url, {url: topUrl, 
					"blacklisted": [url, blacklistedSite ? `User blacklisted ${site}` : "Blacklisted by user"]});
				return ResponseProcessor.REJECT;
			} 
			// use CSP to restrict JavaScript execution in the page
			request.responseHeaders.unshift({
				name: `Content-security-policy`,
				value: `script-src '${blacklistedSite ? 'self' : 'none'}';`
			});
		} else {
			let whitelistedSite = whitelist.contains(site);
			if ((response.whitelisted = (whitelistedSite || whitelist.contains(url)))
					&& type === "script") {
				// accept the script and stop processing
				addReportEntry(tabId, url, {url: topUrl, 
					"whitelisted": [url, whitelistedSite ? `User whitelisted ${site}` : "Whitelisted by user"]});
				return ResponseProcessor.ACCEPT;
			}
		}
		
		// it's a page (it's too early to report) or an unknown script:
		//  let's keep processing
		return ResponseProcessor.CONTINUE;
	},
	
	/**
	*	Here we do the heavylifting, analyzing unknown scripts
	*/
	async post(response) {
		let {type} = response.request;
		let handle_it = type === "script" ? handle_script : handle_html;
		return await handle_it(response, response.whitelisted);
	}
}

/**
* Here we handle external script requests
*/
async function handle_script(response, whitelisted){
	let {text, request} = response;
	let {url, tabId} = request;
	url = ListStore.urlItem(url);
  let edited = await get_script(text, url, tabId, whitelisted, -2);
	return Array.isArray(edited) ? edited[0] : edited;
}

/**
*	Removes noscript tags with name "librejs-path" leaving the inner content to load.
*/
function remove_noscripts(html_doc){
	for(var i = 0; i < html_doc.getElementsByName("librejs-path").length; i++){
		if(html_doc.getElementsByName("librejs-path")[i].tagName == "NOSCRIPT"){
			html_doc.getElementsByName("librejs-path")[i].outerHTML = html_doc.getElementsByName("librejs-path")[i].innerHTML;
		}
	}
	
	return html_doc.documentElement.innerHTML;
}

/**
*	Tests to see if the intrinsic events on the page are free or not.
*	returns true if they are, false if they're not
*/
function read_metadata(meta_element){

		if(meta_element === undefined || meta_element === null){
			return;		
		}

		console.log("metadata found");				
		
		var metadata = {};
		
		try{			
			metadata = JSON.parse(meta_element.innerHTML);
		}catch(error){
			console.log("Could not parse metadata on page.")
			return false;
		}
		
		var license_str = metadata["intrinsic-events"];
		if(license_str === undefined){
			console.log("No intrinsic events license");			
			return false;
		}
		console.log(license_str);

		var parts = license_str.split(" ");
		if(parts.length != 2){
			console.log("invalid (>2 tokens)");
			return false;
		}
	
		// this should be adequete to escape the HTML escaping
		parts[0] = parts[0].replace(/&amp;/g, '&');

		try{
			if(licenses[parts[1]]["Magnet link"] == parts[0]){
				return true;
			}else{
				console.log("invalid (doesn't match licenses)");
				return false;
			}
		} catch(error){
			console.log("invalid (threw error, key didn't exist)");
			return false;
		}
}

/**
* 	Reads/changes the HTML of a page and the scripts within it.
*/
function edit_html(html,url,tabid,wl){
	
	return new Promise((resolve, reject) => {
		if(wl == true){
			// Don't bother, page is whitelisted
			resolve(html);	 
		}
		
		var parser = new DOMParser();
		var html_doc = parser.parseFromString(html, "text/html");

		var amt_scripts = 0;
		var total_scripts = 0;
		var scripts = html_doc.scripts;
		
		var meta_element = html_doc.getElementById("LibreJS-info");
		var first_script_src = "";
		
		// get the potential inline source that can contain a license
		for(var i = 0; i < scripts.length; i++){
			// The script must be in-line and exist
			if(scripts[i] !== undefined && scripts[i].src == ""){
				first_script_src = scripts[i].innerHTML;
				break;
			}
		}

		var license = false;
		if (first_script_src != "")
			license = legacy_license_lib.check(first_script_src);
		if(read_metadata(meta_element) || license != false ){
			console.log("Valid license for intrinsic events found");
			addReportEntry(tabid, url, {url, "accepted":[url, `Global license for the page: ${license}`]});
			// Do not process inline scripts
			scripts="";
		}else{
			// Deal with intrinsic events
			var has_intrinsic_events = [];
			for(var i = 0; i < html_doc.all.length; i++){
				for(var j = 0; j < intrinsic_events.length; j++){
					if(intrinsic_events[j] in html_doc.all[i].attributes){
						has_intrinsic_events.push([i,j]);
					}
				}
			}

			// "i" is an index in html_doc.all
			// "j" is an index in intrinsic_events
			function edit_event(src,i,j,name){
				var edited = get_script(src, name);
				edited.then(function(){
					html_doc.all[i].attributes[intrinsic_events[j]].value = edited[0];
				});
			}

			// Find all the document's elements with intrinsic events
			for(var i = 0; i < has_intrinsic_events.length; i++){
				var s_name = "Intrinsic event ["+has_intrinsic_events[i][0]+"]";
				edit_event(html_doc.all[has_intrinsic_events[i][0]].attributes[intrinsic_events[has_intrinsic_events[i][1]]].value,has_intrinsic_events[i][0],has_intrinsic_events[i][1],s_name);
			}
		}

		// Deal with inline scripts
		for(var i = 0; i < scripts.length; i++){
			if(scripts[i].src == ""){
				total_scripts++;
			}
		}

		dbg_print("Analyzing "+total_scripts+" inline scripts...");

		for(var i = 0; i < scripts.length; i++){
			if (scripts[i].src == ""){
				if (scripts[i].type=="" || scripts[i].type=="text/javascript"){
					var edit_script = get_script(scripts[i].innerHTML,url,tabid,wl,i);
					edit_script.then(function(edited){
						var edited_source = edited[0];
						var unedited_source = html_doc.scripts[edited[1]].innerHTML.trim();
						html_doc.scripts[edited[1]].innerHTML = edited_source;

					});
				}
				amt_scripts++;
				if(amt_scripts >= total_scripts){
				resolve(remove_noscripts(html_doc));
				}
			}
		}
		if(total_scripts == 0){
			dbg_print("Nothing to analyze.");
			resolve(remove_noscripts(html_doc));
		}

	});
}

/**
* Here we handle html document responses
*/
async function handle_html(response, whitelisted) {
	let {text, request} = response;
	let {url, tabId, type} = request;
	url = ListStore.urlItem(url);
	if (type === "main_frame") { 
		delete unused_data[tabId];
		browser.browserAction.setBadgeText({
			text: "✓",
			tabId
		});
		browser.browserAction.setBadgeBackgroundColor({
			color: "green",
			tabId
		});
	}
	return await edit_html(text, url, tabId, whitelisted);
}

var whitelist = new ListStore("pref_whitelist", Storage.CSV);
var blacklist = new ListStore("pref_blacklist", Storage.CSV);
var listManager = new ListManager(whitelist, blacklist,
		// built-in whitelist of script hashes, e.g. jQuery
		Object.values(require("./hash_script/whitelist").whitelist)
			.reduce((a, b) => a.concat(b)) // as a flat array
			.map(script => script.hash)
	);

/**
*	Initializes various add-on functions
*	only meant to be called once when the script starts
*/
async function init_addon(){
	await whitelist.load();
	set_webex();
	webex.runtime.onConnect.addListener(connected);
	webex.storage.onChanged.addListener(options_listener);
	webex.tabs.onRemoved.addListener(delete_removed_tab_info);

	// Prevents Google Analytics from being loaded from Google servers
	let all_types = [
		"beacon", "csp_report", "font", "image", "imageset", "main_frame", "media",
		"object", "object_subrequest", "ping", "script", "stylesheet", "sub_frame",
		"web_manifest", "websocket", "xbl", "xml_dtd", "xmlhttprequest", "xslt", 
		"other"
	];
	webex.webRequest.onBeforeRequest.addListener(
		block_ga,
		{urls: ["<all_urls>"], types: all_types},
		["blocking"]
	);
	
	// Analyzes all the html documents and external scripts as they're loaded
	ResponseProcessor.install(ResponseHandler);

	legacy_license_lib.init();
}


/**
*	Loads the contact finder on the given tab ID.
*/
function inject_contact_finder(tab_id){
	function executed(result) {
	  dbg_print("[TABID:"+tab_id+"]"+"finished executing contact finder: " + result);
	}
	var executing = webex.tabs.executeScript(tab_id, {file: "/contact_finder.js"}, executed);
}

init_addon();
