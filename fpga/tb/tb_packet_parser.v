`timescale 1ns/1ps
module tb_packet_parser;
reg clk=0, reset_n=0, valid=0; reg [7:0] data=0;
always #5 clk=~clk;
wire [1:0] sid; wire [15:0] idx; wire signed [15:0] mhz; wire sv,err;
integer good=0,bad=0;
reg [1:0] want_sid; reg [15:0] want_idx; reg signed [15:0] want_mhz;
packet_parser #(.TIMEOUT_CLOCKS(20)) dut(clk,reset_n,data,valid,sid,idx,mhz,sv,err);
always @(posedge clk) begin
 if(sv) begin
  if(sid!==want_sid || idx!==want_idx || mhz!==want_mhz) $fatal(1,"FAIL parser fields");
  good=good+1;
 end
 if(err) bad=bad+1;
end
task byte_in;
 input [7:0] b;
 begin @(negedge clk); data=b; valid=1; @(negedge clk); valid=0; end
endtask
task packet;
 input [7:0] s; input [15:0] n; input [15:0] x; input corrupt;
 reg [7:0] sum;
 begin
 want_sid=s; want_idx=n; want_mhz=x;
 sum=8'haa+s+n[7:0]+n[15:8]+x[7:0]+x[15:8];
 byte_in(8'haa); byte_in(s); byte_in(n[7:0]); byte_in(n[15:8]);
 byte_in(x[7:0]); byte_in(x[15:8]); byte_in(sum+corrupt);
 repeat(3) @(negedge clk);
 end
endtask
initial begin
 repeat(3) @(negedge clk); reset_n=1;
 byte_in(8'h23);
 packet(0,0,20,0); packet(1,16'haa,-16,0); packet(2,100,-16,0); packet(3,65535,32767,0);
 packet(0,0,0,1); packet(4,0,0,0);
 byte_in(8'haa); byte_in(0); repeat(25) @(negedge clk);
 byte_in(8'haa); byte_in(0); reset_n=0; repeat(2) @(negedge clk); reset_n=1;
 packet(0,0,16'h80aa,0);
 if(good!=5 || bad!=3) $fatal(1,"FAIL parser counts %d %d",good,bad);
 $display("PASS parser signed fields, IDs, payload AA, checksum, timeout, reset"); $finish;
end
initial begin #100000; $fatal(1,"FAIL parser timeout"); end
endmodule
