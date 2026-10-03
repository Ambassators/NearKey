package dev.nearkeylite
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
class Api(private val origin:String,private val token:String?=null){init{val u=URI(origin);require(u.host!=null&&(u.scheme=="https"||(BuildConfig.DEBUG&&u.scheme=="http"&&u.host in listOf("localhost","127.0.0.1"))))}
 fun get(path:String)=call(path,null);fun post(path:String,b:JSONObject)=call(path,b)
 private fun call(path:String,b:JSONObject?):JSONObject{val c=URI(origin.trimEnd('/')+path).toURL().openConnection() as HttpURLConnection;try{c.connectTimeout=8000;c.readTimeout=8000;c.instanceFollowRedirects=false;c.setRequestProperty("accept","application/json");token?.let{c.setRequestProperty("authorization","Bearer $it")};if(b!=null){c.requestMethod="POST";c.doOutput=true;c.setRequestProperty("content-type","application/json");c.outputStream.use{it.write(b.toString().toByteArray())}};val status=c.responseCode,raw=(if(status in 200..299)c.inputStream else c.errorStream).bufferedReader().readText(),o=JSONObject(raw);check(status in 200..299){o.optString("error","Request failed")};return o}finally{c.disconnect()}}
}
